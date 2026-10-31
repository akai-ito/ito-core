export type Account = "icloud" | "outlook" | "gmail";

export type Endpoint = { readonly host: string; readonly port: number; readonly secure: boolean };

export type Provider = { readonly imap: Endpoint; readonly smtp: Endpoint };

export const providers: Readonly<Record<Account, Provider>> = {
  icloud: {
    imap: { host: "imap.mail.me.com", port: 993, secure: true },
    smtp: { host: "smtp.mail.me.com", port: 587, secure: false },
  },
  outlook: {
    imap: { host: "outlook.office365.com", port: 993, secure: true },
    smtp: { host: "smtp-mail.outlook.com", port: 587, secure: false },
  },
  gmail: {
    imap: { host: "imap.gmail.com", port: 993, secure: true },
    smtp: { host: "smtp.gmail.com", port: 465, secure: true },
  },
};

export const signInHints: Readonly<Record<Account, string>> = {
  icloud: "iCloud Mail needs an app-specific password from account.apple.com, not the Apple Account password.",
  outlook: "Outlook.com needs a fresh Microsoft sign-in; its access token may have expired.",
  gmail: "Gmail needs an app password (with 2-Step Verification on) or a fresh Google sign-in.",
};
