import type { Builtin, CheckResult, Installed } from "#capabilities/host.ts";
import type { Manifest, Values } from "#capabilities/manifest.ts";

export type SourceChecks = {
  readonly icloud: (values: Values) => Promise<CheckResult>;
  readonly outlook: (values: Values) => Promise<CheckResult>;
  readonly gmail: (values: Values) => Promise<CheckResult>;
};

export const icloudSource = "icloud";

export const outlookSource = "outlook";

export const gmailSource = "gmail";

export const outlookClientId = "8aa28949-aa33-43b1-a44b-c4f6936ea9fe";

export const outlookScope = "https://outlook.office.com/IMAP.AccessAsUser.All offline_access";

const microsoft = "https://login.microsoftonline.com/consumers/oauth2/v2.0";

const icloud: Manifest = {
  id: icloudSource,
  version: "0.1",
  kind: "source",
  title: "iCloud",
  symbol: "icloud",
  summary: "Your iCloud Mail and Calendar, read and kept by Kumo on your box.",
  setup: [
    {
      name: "apple_id",
      kind: "text",
      title: "Apple ID",
      description: "The email address you sign in to iCloud with.",
    },
    {
      name: "app_password",
      kind: "secret",
      title: "App-specific password",
      description: [
        "Apple has no sign-in for other apps, so Kumo uses an app-specific password.",
        "1. Open Apple Account and sign in.",
        "2. In Sign-In and Security, choose App-Specific Passwords.",
        "3. Add one called Ito, and paste it here.",
        "",
        "It goes to your box only. One connection covers Mail and Calendar.",
      ].join("\n"),
      connect: { kind: "link", title: "Open Apple Account", url: "https://account.apple.com/account/manage" },
    },
  ],
  operations: [],
  skill: "",
  uses: { hosts: ["caldav.icloud.com", "imap.mail.me.com", "smtp.mail.me.com"], folders: [] },
};

const outlook: Manifest = {
  id: outlookSource,
  version: "0.1",
  kind: "source",
  title: "Outlook",
  symbol: "envelope",
  summary: "Your Outlook.com mail, read by Kumo on your box. Kumo writes drafts and never sends.",
  setup: [
    { name: "address", kind: "text", title: "Outlook address", description: "Your Outlook.com address." },
    {
      name: "token",
      kind: "secret",
      title: "Microsoft account",
      description: [
        "Sign in with Microsoft so Kumo can read your Outlook.com mail.",
        "1. Open Microsoft and enter the code.",
        "2. Sign in, and allow access to your mail.",
        "",
        "The box keeps the sign-in and renews it itself.",
      ].join("\n"),
      connect: {
        kind: "oauth_device",
        title: "Open Microsoft",
        deviceUrl: `${microsoft}/devicecode`,
        tokenUrl: `${microsoft}/token`,
        clientId: outlookClientId,
        scope: outlookScope,
      },
    },
  ],
  operations: [],
  skill: "",
  uses: { hosts: ["login.microsoftonline.com", "outlook.office365.com"], folders: [] },
};

const gmail: Manifest = {
  id: gmailSource,
  version: "0.1",
  kind: "source",
  title: "Gmail",
  symbol: "envelope",
  summary: "Your Gmail, read by Kumo on your box. Kumo writes drafts and never sends.",
  setup: [
    { name: "address", kind: "text", title: "Gmail address", description: "Your Gmail address." },
    {
      name: "app_password",
      kind: "secret",
      title: "App password",
      description: [
        "Gmail lets other apps in with an app password, once 2-Step Verification is on.",
        "1. Open Google App Passwords and sign in.",
        "2. Make one called Ito.",
        "3. Paste the 16 letters here.",
        "",
        "It goes to your box only.",
      ].join("\n"),
      connect: { kind: "link", title: "Open Google", url: "https://myaccount.google.com/apppasswords" },
    },
  ],
  operations: [],
  skill: "",
  uses: { hosts: ["imap.gmail.com", "smtp.gmail.com"], folders: [] },
};

const builtin = (manifest: Manifest, check: Builtin["check"]): Installed => ({
  id: manifest.id,
  builtin: { manifest, check },
});

export const toSources = (checks: SourceChecks): readonly Installed[] => [
  builtin(icloud, checks.icloud),
  builtin(outlook, checks.outlook),
  builtin(gmail, checks.gmail),
];
