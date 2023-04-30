import { Caveat, Identifier, Lsat } from 'lsat-js'
import { EventKinds } from '../constants/base'
import { Invoice } from '../@types/invoice'
import * as Macaroon from 'macaroon'
import bolt11 from 'bolt11'
import { IncomingEventMessage } from '../@types/messages'

export const createLsat = (invoice: Invoice, kinds?: EventKinds[]): Lsat => {
  try {
    const req = bolt11.decode(invoice.bolt11)
    const identifier = new Identifier({
      paymentHash: Buffer.from(req.tagsObject.payment_hash, 'hex'),
    })
    // probably a better way to do this. want to get the relay information too
    const secret = process.env.SECRET
    const builder = Macaroon.newMacaroon({
      version: 1,
      location: 'my-relay',
      rootKey: secret,
      identifier: identifier.toString(),
    })
    const kindsCaveat = new Caveat({ condition: 'kinds', value: kinds.join() })
    builder.addFirstPartyCaveat(kindsCaveat.encode())
    const builderBin = builder._exportBinaryV2()
    const macaroon = Macaroon.bytesToBase64(builderBin)
    return Lsat.fromMacaroon(macaroon, invoice.bolt11)
  } catch (e) {
    console.error(e)
  }
}

export const getLsatFromMessage = (message: IncomingEventMessage) => {
  const [_kind, { tags }] = message
  const [_relayTag, challengeTag] = tags
  if (challengeTag[0] !== "challenge") {
    // TODO figure out how to handle errors
    console.error(`expected a challenge tag in auth event. instead received ${challengeTag[0]}`)
    throw new Error("Invalid auth message")
  }
  const challenge = challengeTag[1]
  const lsat = Lsat.fromToken(challenge)
  return lsat
}