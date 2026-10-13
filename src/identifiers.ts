import { randomBytes } from "node:crypto";
import { toEventId, toMessageId, toTurnId, type EventId, type MessageId, type TurnId } from "#conversation/ids.ts";

export type Identifiers = {
  readonly event: () => EventId;
  readonly message: () => MessageId;
  readonly turn: () => TurnId;
};

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
const idLength = 20;

const randomText = (): string =>
  [...randomBytes(idLength)].map((byte) => alphabet.charAt(byte % alphabet.length)).join("");

export const randomIdentifiers: Identifiers = {
  event: () => toEventId(`e_${randomText()}`),
  message: () => toMessageId(`m_${randomText()}`),
  turn: () => toTurnId(`t_${randomText()}`),
};
