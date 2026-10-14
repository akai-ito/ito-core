import { randomBytes } from "node:crypto";
import {
  toEventId,
  toMessageId,
  toStepId,
  toTurnId,
  type EventId,
  type MessageId,
  type StepId,
  type TurnId,
} from "#conversation/ids.ts";

export type Identifiers = {
  readonly event: () => EventId;
  readonly message: () => MessageId;
  readonly turn: () => TurnId;
  readonly step: () => StepId;
};

const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
const idLength = 20;

const randomText = (): string =>
  [...randomBytes(idLength)].map((byte) => alphabet.charAt(byte % alphabet.length)).join("");

export const randomIdentifiers: Identifiers = {
  event: () => toEventId(`e_${randomText()}`),
  message: () => toMessageId(`m_${randomText()}`),
  turn: () => toTurnId(`t_${randomText()}`),
  step: () => toStepId(`s_${randomText()}`),
};
