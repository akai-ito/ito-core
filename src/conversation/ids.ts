declare const brand: unique symbol;

type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };

export type EventId = Brand<string, "EventId">;
export type MessageId = Brand<string, "MessageId">;
export type TurnId = Brand<string, "TurnId">;
export type StepId = Brand<string, "StepId">;
export type AskId = Brand<string, "AskId">;
export type DeviceId = Brand<string, "DeviceId">;
export type ChangeId = Brand<string, "ChangeId">;

export const toEventId = (value: string): EventId => value as EventId;
export const toMessageId = (value: string): MessageId => value as MessageId;
export const toTurnId = (value: string): TurnId => value as TurnId;
export const toStepId = (value: string): StepId => value as StepId;
export const toAskId = (value: string): AskId => value as AskId;
export const toDeviceId = (value: string): DeviceId => value as DeviceId;
export const toChangeId = (value: string): ChangeId => value as ChangeId;
