import { createTransport } from "nodemailer";
import type { Endpoint } from "#mail/providers.ts";
import { fail, ok, type Result } from "#result.ts";

export type Credentials =
  { readonly user: string; readonly pass: string } | { readonly user: string; readonly accessToken: string };

export type Letter = { readonly from: string; readonly to: string; readonly subject: string; readonly text: string };

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const sendLetter = async (
  endpoint: Endpoint,
  credentials: Credentials,
  letter: Letter,
): Promise<Result<undefined, string>> => {
  const transport = createTransport({
    host: endpoint.host,
    port: endpoint.port,
    secure: endpoint.secure,
    requireTLS: !endpoint.secure,
    auth:
      "pass" in credentials
        ? { user: credentials.user, pass: credentials.pass }
        : { type: "OAuth2", user: credentials.user, accessToken: credentials.accessToken },
  });
  try {
    await transport.sendMail(letter);
    return ok(undefined);
  } catch (error) {
    return fail(`${endpoint.host} didn't send the mail: ${describe(error)}`);
  } finally {
    transport.close();
  }
};
