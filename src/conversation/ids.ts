declare const brand: unique symbol;

type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type EventId = Brand<string, "EventId">;
export type MessageId = Brand<string, "MessageId">;
export type TurnId = Brand<string, "TurnId">;

export const toEventId = (value: string): EventId => value as EventId;
export const toMessageId = (value: string): MessageId => value as MessageId;
export const toTurnId = (value: string): TurnId => value as TurnId;
