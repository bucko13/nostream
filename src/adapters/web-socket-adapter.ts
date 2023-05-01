import cluster from 'cluster'
import { EventEmitter } from 'stream'
import { IncomingMessage as IncomingHttpMessage } from 'http'
import { WebSocket } from 'ws'

import { ContextMetadata, Factory } from '../@types/base'
import { createAuth402Message, createNoticeMessage, createOutgoingEventMessage } from '../utils/messages'
import { IAbortable, IMessageHandler } from '../@types/message-handlers'
import { IncomingEventMessage, IncomingMessage, OutgoingMessage } from '../@types/messages'
import { IWebSocketAdapter, IWebSocketServerAdapter } from '../@types/adapters'
import { SubscriptionFilter, SubscriptionId } from '../@types/subscription'
import { WebSocketAdapterEvent, WebSocketServerAdapterEvent } from '../constants/adapter'
import { attemptValidation } from '../utils/validation'
import { ContextMetadataKey, EventKinds } from '../constants/base'
import { createLogger } from '../factories/logger-factory'
import { createLsat, getLsatFromMessage } from '../utils/lsat'
import { Event } from '../@types/event'
import { getRemoteAddress } from '../utils/http'
import { IPaymentsService } from '../@types/services'
import { IRateLimiter } from '../@types/utils'
import { isEventMatchingFilter } from '../utils/event'
import { Lsat } from 'lsat-js'
import { messageSchema } from '../schemas/message-schema'
import { Settings } from '../@types/settings'
import { SocketAddress } from 'net'
import { InvoiceStatus } from '../@types/invoice'


const debug = createLogger('web-socket-adapter')
const debugHeartbeat = debug.extend('heartbeat')

const abortableMessageHandlers: WeakMap<WebSocket, IAbortable[]> = new WeakMap()

export class WebSocketAdapter extends EventEmitter implements IWebSocketAdapter {
  public clientId: string
  private clientAddress: SocketAddress
  private alive: boolean
  private subscriptions: Map<SubscriptionId, SubscriptionFilter[]>
  // use this to track if the session has been authed
  private authed402: boolean

  public constructor(
    private readonly client: WebSocket,
    private readonly request: IncomingHttpMessage,
    private readonly webSocketServer: IWebSocketServerAdapter,
    private readonly createMessageHandler: Factory<IMessageHandler, [IncomingMessage, IWebSocketAdapter]>,
    private readonly slidingWindowRateLimiter: Factory<IRateLimiter>,
    private readonly settings: Factory<Settings>,
    private readonly paymentsService: IPaymentsService,
  ) {
    super()
    this.alive = true
    this.authed402 = false
    this.subscriptions = new Map()

    this.clientId = Buffer.from(this.request.headers['sec-websocket-key'] as string, 'base64').toString('hex')

    const address = getRemoteAddress(this.request, this.settings())

    this.clientAddress = new SocketAddress({
      address: address,
      family: address.indexOf(':') >= 0 ? 'ipv6' : 'ipv4',
    })

    this.client
      .on('error', (error) => {
        if (error.name === 'RangeError' && error.message === 'Max payload size exceeded') {
          console.error(`web-socket-adapter: client ${this.clientId} (${this.getClientAddress()}) sent payload too large`)
        } else if (error.name === 'RangeError' && error.message === 'Invalid WebSocket frame: RSV1 must be clear') {
          debug(`client ${this.clientId} (${this.getClientAddress()}) enabled compression`)
        } else {
          console.error(`web-socket-adapter: client error ${this.clientId} (${this.getClientAddress()}):`, error)
        }

        this.client.close()
      })
      .on('message', this.onClientMessage.bind(this))
      .on('close', this.onClientClose.bind(this))
      .on('pong', this.onClientPong.bind(this))
      .on('ping', this.onClientPing.bind(this))

    this
      .on(WebSocketAdapterEvent.Heartbeat, this.onHeartbeat.bind(this))
      .on(WebSocketAdapterEvent.Subscribe, this.onSubscribed.bind(this))
      .on(WebSocketAdapterEvent.Unsubscribe, this.onUnsubscribed.bind(this))
      .on(WebSocketAdapterEvent.Event, this.onSendEvent.bind(this))
      .on(WebSocketAdapterEvent.Broadcast, this.onBroadcast.bind(this))
      .on(WebSocketAdapterEvent.Message, this.sendMessage.bind(this))

    debug('client %s connected from %s', this.clientId, this.clientAddress.address)
  }

  public getClientId(): string {
    return this.clientId
  }

  public getClientAddress(): string {
    return this.clientAddress.address
  }

  public onUnsubscribed(subscriptionId: string): void {
    debug('client %s unsubscribed %s', this.clientId, subscriptionId)
    this.subscriptions.delete(subscriptionId)
  }

  public onSubscribed(subscriptionId: string, filters: SubscriptionFilter[]): void {
    debug('client %s subscribed %s to %o', this.clientId, subscriptionId, filters)
    this.subscriptions.set(subscriptionId, filters)
  }

  public onBroadcast(event: Event): void {
    this.webSocketServer.emit(WebSocketServerAdapterEvent.Broadcast, event)
    if (cluster.isWorker && typeof process.send === 'function') {
      process.send({
        eventName: WebSocketServerAdapterEvent.Broadcast,
        event,
      })
    }
  }

  public onSendEvent(event: Event): void {
    this.subscriptions.forEach((filters, subscriptionId) => {
      if (
        filters.map(isEventMatchingFilter).some((isMatch) => isMatch(event))
      ) {
        debug('sending event to client %s: %o', this.clientId, event)
        this.sendMessage(createOutgoingEventMessage(subscriptionId, event))
      }
    })
  }

  private sendMessage(message: OutgoingMessage): void {
    if (this.client.readyState !== WebSocket.OPEN) {
      return
    }
    this.client.send(JSON.stringify(message))
  }

  public onHeartbeat(): void {
    if (!this.alive && !this.subscriptions.size) {
      console.error(`web-socket-adapter: pong timeout for client ${this.clientId} (${this.getClientAddress()})`)
      this.client.close()
      return
    }

    this.alive = false
    this.client.ping()
    debugHeartbeat('client %s ping', this.clientId)
  }

  public getSubscriptions(): Map<string, SubscriptionFilter[]> {
    return new Map(this.subscriptions)
  }

  private async onClientMessage(raw: Buffer) {
    this.alive = true
    let abortable = false
    let messageHandler: IMessageHandler & IAbortable | undefined = undefined
    try {
      if (await this.isRateLimited(this.clientAddress.address)) {
        this.sendMessage(createNoticeMessage('rate limited'))
        return
      }

      const message: IncomingEventMessage = attemptValidation(messageSchema)(JSON.parse(raw.toString('utf8')))

      message[ContextMetadataKey] = {
        remoteAddress: this.clientAddress,
      } as ContextMetadata

      messageHandler = this.createMessageHandler([message, this]) as IMessageHandler & IAbortable
      if (!messageHandler) {
        console.error('web-socket-adapter: unhandled message: no handler found:', message)
        return
      }

      abortable = typeof messageHandler.abort === 'function'

      if (abortable) {
        const handlers = abortableMessageHandlers.get(this.client) ?? []
        handlers.push(messageHandler)
        abortableMessageHandlers.set(this.client, handlers)
      }

      // TODO: is there a way to split this up?
      // TODO: what if the message is an auth event. need to handle separately
      const [, event] = message
      if (!this.authed402 && event?.pubkey && event.kind !== EventKinds.AUTH_402_MESSAGE) {
        // client is not authed and this is not an auth message with lsat
        // response, so we want to send the lsat back to the user
        const invoice = await this.paymentsService.createInvoice(
          event.pubkey,
          BigInt(500000), // 2,000,000 millisatoshis (2k sats)
          'Auth with 402 for my relay'
        )
        const lsat = createLsat(invoice, [1, 9, 11])
        this.sendMessage(createAuth402Message(lsat.toChallenge()))
        return
      } else if (!this.authed402 && event.kind === EventKinds.AUTH_402_MESSAGE) {
        const lsat = getLsatFromMessage(message)
        const isAuthorized = await this.authorize402Channel(lsat)
        if (!isAuthorized) {
          console.log('Still not authorized!')
          this.sendMessage(createAuth402Message(lsat.toChallenge()))
          return
        }
        console.log('The invoice was paid! Still need to check permissions')
      }

      await messageHandler.handleMessage(message)
    } catch (error) {
      if (error instanceof Error) {
        if (error.name === 'AbortError') {
          console.error(`web-socket-adapter: abort from client ${this.clientId} (${this.getClientAddress()})`)
        } else if (error.name === 'SyntaxError' || error.name === 'ValidationError') {
          if (typeof (error as any).annotate === 'function') {
            debug('invalid message client %s (%s): %o', this.clientId, this.getClientAddress(), (error as any).annotate())
          } else {
            console.error(`web-socket-adapter: malformed message from client ${this.clientId} (${this.getClientAddress()}):`, error.message)
          }
          this.sendMessage(createNoticeMessage(`invalid: ${error.message}`))
        }
      } else {
        console.error('web-socket-adapter: unable to handle message:', error)
      }
    } finally {
      if (abortable && messageHandler) {
        const handlers = abortableMessageHandlers.get(this.client)
        if (handlers) {
          const index = handlers.indexOf(messageHandler)
          if (index >= 0) {
            handlers.splice(index, 1)
          }
        }
      }
    }
  }

  private async isRateLimited(client: string): Promise<boolean> {
    const {
      rateLimits,
      ipWhitelist = [],
    } = this.settings().limits?.message ?? {}

    if (!Array.isArray(rateLimits) || !rateLimits.length || ipWhitelist.includes(client)) {
      return false
    }

    const rateLimiter = this.slidingWindowRateLimiter()

    const hit = (period: number, rate: number) =>
      rateLimiter.hit(
        `${client}:message:${period}`,
        1,
        { period, rate },
      )

    let limited = false
    for (const { rate, period } of rateLimits) {
      const isRateLimited = await hit(period, rate)


      if (isRateLimited) {
        debug('rate limited %s: %d messages / %d ms exceeded', client, rate, period)

        limited = true
      }
    }

    return limited
  }

  private onClientPong() {
    debugHeartbeat('client %s pong', this.clientId)
    this.alive = true
  }

  private onClientPing(data: any) {
    debugHeartbeat('client %s ping', this.clientId)
    this.client.pong(data)
    this.alive = true
  }

  private onClientClose() {
    this.alive = false
    this.subscriptions.clear()

    const handlers = abortableMessageHandlers.get(this.client)
    if (Array.isArray(handlers) && handlers.length) {
      for (const handler of handlers) {
        try {
          handler.abort()
        } catch (error) {
          console.error('Unable to abort message handler', error)
        }
      }
    }

    this.removeAllListeners()
    this.client.removeAllListeners()
  }

  private async authorize402Channel(lsat: Lsat) {
    const { invoice } = lsat
    let status
    try {
      status = await this.paymentsService.checkInvoiceStatus(invoice)
      this.authed402 = status ? status === InvoiceStatus.COMPLETED : false
      return this.authed402
    } catch (e) {
      console.error(e)
    }
  }
}
