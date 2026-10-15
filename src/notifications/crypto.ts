import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Notification } from "#protocol/types.ts";

export type Sealed = { readonly v: 1; readonly k: string; readonly n: string; readonly c: string };

export type DeviceKey = { readonly id: string; readonly notificationKey: string; readonly keyId: string };

const nonceBytes = 12;
const tagBytes = 16;

export const sealNotification = (
  notification: Notification,
  device: DeviceKey,
  nonce: Buffer = randomBytes(nonceBytes),
): Sealed => {
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(device.notificationKey, "base64"), nonce);
  cipher.setAAD(Buffer.from(device.id, "utf8"));
  const sealed = Buffer.concat([
    cipher.update(JSON.stringify(notification), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return { v: 1, k: device.keyId, n: nonce.toString("base64"), c: sealed.toString("base64") };
};

export const openNotification = (sealed: Sealed, device: Pick<DeviceKey, "id" | "notificationKey">): Notification => {
  const data = Buffer.from(sealed.c, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(device.notificationKey, "base64"),
    Buffer.from(sealed.n, "base64"),
  );
  decipher.setAAD(Buffer.from(device.id, "utf8"));
  decipher.setAuthTag(data.subarray(data.length - tagBytes));
  const plain = Buffer.concat([decipher.update(data.subarray(0, data.length - tagBytes)), decipher.final()]);
  return JSON.parse(plain.toString("utf8")) as Notification;
};
