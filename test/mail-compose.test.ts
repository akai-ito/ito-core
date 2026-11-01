import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { composeLetter, createFindPart, largestPartBytes, type FindPart, type Letter } from "#mail/compose.ts";
import { toDraftMime, type Draft, type SentBody } from "#mail/message.ts";
import { learnSignature } from "#mail/signature.ts";
import { createCell } from "#cell.ts";
import { fail, ok, type Result } from "#result.ts";
import { draftShape, mimeTree, shapeOf } from "./support/mime.ts";

const jpeg = Buffer.from([255, 216, 255, 224, 0, 16, 74, 70, 73, 70]);

const value = <Value>(result: Result<Value, string>): Value => {
  if (!result.ok) throw new Error(result.failure);
  return result.value;
};

// Finds every picture as a small JPEG, and every file as a short PDF, by its name.
const findAny: FindPart = (reference, kind) =>
  Promise.resolve(
    ok(
      kind === "image"
        ? { filename: path.basename(reference), contentType: "image/jpeg", content: jpeg }
        : { filename: path.basename(reference), contentType: "application/pdf", content: Buffer.from("%PDF-1.7") },
    ),
  );

const sentMail = (body: string, html?: string): SentBody => ({
  text: body,
  ...(html !== undefined && { html }),
  images: [],
});

// Every file as a PDF the size of the most one file can be.
const huge: FindPart = (reference) =>
  Promise.resolve(ok({ filename: reference, contentType: "application/pdf", content: Buffer.alloc(largestPartBytes) }));

const draftOf = (letter: Letter): Draft => ({
  from: { address: "divy@icloud.com" },
  to: [{ address: "leo@halcyon.example", name: "Leo" }],
  subject: "The weekend",
  body: letter.text,
  html: letter.html,
  inline: letter.inline,
  attachments: letter.attachments,
});

const plan = [
  "Hi Leo,",
  "",
  "Here's **the plan** for the weekend:",
  "",
  "- Fly out *Friday* evening",
  "- Back on Sunday",
  "",
  "See [Hotel Orto](https://hotelorto.example/rooms).",
  "",
  "![Leo at the beach](uploads/beach%20day.jpg)",
  "",
  "Cheers,",
  "Divy",
].join("\n");

describe("a draft as formatted mail", () => {
  it("writes the Markdown as HTML with a clean plain-text copy, pictures inline by Content-ID", async () => {
    const letter = value(await composeLetter({ markdown: plan, attach: [], find: findAny }));

    expect(letter.html).toContain("<strong>the plan</strong>");
    expect(letter.html).toContain("<li>Fly out <em>Friday</em> evening</li>");
    expect(letter.html).toContain('<a href="https://hotelorto.example/rooms">Hotel Orto</a>');
    expect(letter.html).toMatch(
      /<img style="max-width: 100%" src="cid:[\da-f-]{36}@ito\.local" alt="Leo at the beach">/u,
    );
    expect(letter.inline).toEqual([
      { filename: "beach%20day.jpg", contentType: "image/jpeg", content: jpeg, cid: expect.any(String) as unknown },
    ]);
    expect(letter.html).toContain(`cid:${letter.inline[0]?.cid ?? ""}`);
    expect(letter.text).toBe(
      [
        "Hi Leo,",
        "",
        "Here's the plan for the weekend:",
        "",
        "- Fly out Friday evening",
        "- Back on Sunday",
        "",
        "See Hotel Orto (https://hotelorto.example/rooms).",
        "",
        "[image: Leo at the beach]",
        "",
        "Cheers,",
        "Divy",
      ].join("\n"),
    );
    expect(letter.attachments).toEqual([]);
  });

  it("never lets raw HTML in the words through as HTML", async () => {
    const letter = value(
      await composeLetter({ markdown: 'Hi <script>alert("x")</script> there', attach: [], find: findAny }),
    );

    expect(letter.html).not.toContain("<script>");
    expect(letter.html).toContain("&lt;script&gt;");
  });

  it("adds their signature at the end, in HTML and in plain text, with its own pictures", async () => {
    const logo = { cid: "logo@northwind.example", filename: "logo.png", contentType: "image/png", content: jpeg };
    const letter = value(
      await composeLetter({
        markdown: "Thanks, Tess.",
        attach: ["notes.pdf"],
        find: findAny,
        signature: {
          text: "Divy Bramhecha\nNorthwind",
          html: '<div>Divy Bramhecha</div><div><img src="cid:logo@northwind.example"> Northwind</div>',
          images: [logo],
        },
      }),
    );

    expect(letter.text).toBe("Thanks, Tess.\n\nDivy Bramhecha\nNorthwind");
    expect(letter.html).toContain(
      '<p>Thanks, Tess.</p>\n<br>\n<div>Divy Bramhecha</div><div><img src="cid:logo@northwind.example"> Northwind</div>',
    );
    expect(letter.inline).toEqual([logo]);
    expect(letter.attachments.map(({ filename }) => filename)).toEqual(["notes.pdf"]);
  });

  it("writes a plain signature into the HTML line by line", async () => {
    const letter = value(
      await composeLetter({
        markdown: "See you then.",
        attach: [],
        find: findAny,
        signature: { text: "-- \nDivy Bramhecha\n+44 7700 900123", images: [] },
      }),
    );

    expect(letter.html).toContain("<div>-- <br>Divy Bramhecha<br>+44 7700 900123</div>");
  });

  it("says which picture or file it couldn't find, and keeps the whole mail under the size a mail can carry", async () => {
    const missing = await composeLetter({
      markdown: "![Leo](uploads/gone.jpg)",
      attach: [],
      find: (reference) => Promise.resolve(fail(`There's no ${reference} in your workspace.`)),
    });
    const tooMuch = await composeLetter({ markdown: "Here.", attach: ["a.pdf", "b.pdf"], find: huge });

    expect(missing).toEqual({ ok: false, failure: "There's no uploads/gone.jpg in your workspace." });
    expect(tooMuch.ok ? "" : tooMuch.failure).toMatch(/^That's 20 MB of pictures and files, over the 15 MB/u);
  });
});

describe("a draft's MIME", () => {
  it("is multipart/alternative, with inline pictures in multipart/related beside the HTML", async () => {
    const letter = value(await composeLetter({ markdown: plan, attach: [], find: findAny }));
    const tree = mimeTree(await toDraftMime(draftOf(letter), "draft-1@icloud.com", new Date()));
    const related = tree.parts[1];
    const picture = related?.parts[1];

    expect(shapeOf(tree)).toEqual([
      "multipart/alternative",
      ["text/plain", ["multipart/related", ["text/html", "image/jpeg"]]],
    ]);
    expect(picture?.headers["content-id"]).toBe(`<${letter.inline[0]?.cid ?? ""}>`);
    expect(picture?.headers["content-disposition"]).toMatch(/^inline/u);
  });

  it("is multipart/mixed around it when files are attached, and plain alternative with neither", async () => {
    const withFile = value(await composeLetter({ markdown: plan, attach: ["itinerary.pdf"], find: findAny }));
    const wordsOnly = value(await composeLetter({ markdown: "**Yes**, Thursday works.", attach: [], find: findAny }));

    expect(await draftShape(draftOf(withFile))).toEqual([
      "multipart/mixed",
      [
        ["multipart/alternative", ["text/plain", ["multipart/related", ["text/html", "image/jpeg"]]]],
        "application/pdf",
      ],
    ]);
    expect(await draftShape(draftOf(wordsOnly))).toEqual(["multipart/alternative", ["text/plain", "text/html"]]);
  });
});

describe("finding pictures and files for a draft", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "ito-compose-"));
  const workspace = path.join(home, "workspace");
  mkdirSync(path.join(workspace, "uploads"), { recursive: true });
  writeFileSync(path.join(workspace, "uploads", "beach day.jpg"), jpeg);
  writeFileSync(path.join(workspace, "uploads", "notes.txt"), "Pack light.");
  writeFileSync(path.join(home, "secret.txt"), "Not for mail.");
  symlinkSync(path.join(home, "secret.txt"), path.join(workspace, "uploads", "sneaky.txt"));

  const answers = createCell<ReadonlyMap<string, () => Response>>(new Map());
  const answer = (url: string, response: () => Response): void => {
    answers.update((current) => new Map([...current, [url, response]]));
  };
  const find = createFindPart({
    workspace,
    fetch: (url) => Promise.resolve(answers.get().get(url)?.() ?? new Response("", { status: 404 })),
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("reads workspace files, by a path as Markdown writes it, and nothing outside the workspace", async () => {
    const picture = value(await find("uploads/beach%20day.jpg", "image"));

    expect(picture).toEqual({ filename: "beach day.jpg", contentType: "image/jpeg", content: jpeg });
    expect(await find("uploads/notes.txt", "image")).toEqual({
      ok: false,
      failure: "uploads/notes.txt isn't a picture.",
    });
    expect(value(await find("uploads/notes.txt", "file")).contentType).toBe("text/plain");
    expect(await find("../secret.txt", "file")).toEqual({
      ok: false,
      failure: "../secret.txt isn't in your workspace, so it can't go in a mail.",
    });
    expect(await find("uploads/sneaky.txt", "file")).toEqual({
      ok: false,
      failure: "uploads/sneaky.txt isn't in your workspace, so it can't go in a mail.",
    });
    expect(await find("file:///etc/hosts", "file")).toEqual({
      ok: false,
      failure: "file:///etc/hosts isn't a workspace path or an https address.",
    });
    expect(await find("uploads/missing.jpg", "image")).toEqual({
      ok: false,
      failure: "There's no uploads/missing.jpg in your workspace.",
    });
  });

  it("downloads a picture from the web, only a picture, and only a small enough one", async () => {
    answer("https://pics.example/leo.jpg", () => new Response(jpeg, { headers: { "content-type": "image/jpeg" } }));
    answer("https://pics.example/page", () => new Response("<html>", { headers: { "content-type": "text/html" } }));
    answer(
      "https://pics.example/huge.jpg",
      () =>
        new Response(jpeg, {
          headers: { "content-type": "image/jpeg", "content-length": String(largestPartBytes + 1) },
        }),
    );

    expect(value(await find("https://pics.example/leo.jpg", "image"))).toEqual({
      filename: "leo.jpg",
      contentType: "image/jpeg",
      content: jpeg,
    });
    expect(await find("https://pics.example/page", "image")).toEqual({
      ok: false,
      failure: "https://pics.example/page is text/html, not a picture. Give the picture's own address.",
    });
    expect(await find("https://pics.example/huge.jpg", "image")).toEqual({
      ok: false,
      failure: "https://pics.example/huge.jpg is over 10 MB: find a smaller version.",
    });
    expect(await find("https://pics.example/gone.jpg", "image")).toEqual({
      ok: false,
      failure: "https://pics.example/gone.jpg answered 404.",
    });
  });
});

describe("learning their signature from what they sent", () => {
  const block = ["Divy Bramhecha", "Product Engineer · Northwind", "+44 7700 900123"];

  it("finds the block that ends most of their mail, without the sign-off they vary", () => {
    const sent = [
      sentMail(["Hi Clara,", "", "Sounds good.", "", "Cheers,", "Divy", "", ...block].join("\n")),
      sentMail(["Hello Tess,", "", "Thursday works.", "", "Thanks!", "Divy", "", ...block].join("\n")),
      sentMail(["Quick one: yes.", "", "Divy", "", ...block].join("\n")),
      sentMail(["Sent from the phone, short.", "", "Sent from my iPhone"].join("\n")),
    ];

    expect(learnSignature(sent)).toEqual({ text: block.join("\n"), images: [] });
  });

  it("takes what follows their -- line", () => {
    const sent = [
      sentMail(["Sure.", "", "-- ", "Divy", "divy.example"].join("\n")),
      sentMail(["On it.", "", "-- ", "Divy", "divy.example"].join("\n")),
    ];

    expect(learnSignature(sent)).toEqual({ text: "-- \nDivy\ndivy.example", images: [] });
  });

  it("finds none when their mail only ends with a sign-off, a name or a phone's line", () => {
    const signOffs = [
      sentMail(["Sounds good.", "", "Cheers,", "Divy"].join("\n")),
      sentMail(["Thursday works.", "", "Thanks,", "Divy"].join("\n")),
      sentMail(["Yes.", "", "Divy"].join("\n")),
    ];
    const phone = [
      sentMail(["Sounds good.", "", "Sent from my iPhone"].join("\n")),
      sentMail(["Yes please.", "", "Sent from my iPhone"].join("\n")),
    ];

    expect(learnSignature(signOffs)).toBeUndefined();
    expect(learnSignature(phone)).toBeUndefined();
    const lonely = sentMail(["One mail", "", ...block].join("\n"));

    expect(learnSignature([lonely])).toBeUndefined();
  });

  it("keeps the HTML they actually send, one div a line, and not an older copy in a quoted reply", () => {
    const html = [
      "<div>Sounds good.</div><div><br></div><div>Cheers,</div><div>Divy</div><div><br></div>",
      '<div>Divy Bramhecha</div><div style="color: #555">Product Engineer · <b>Northwind</b></div>',
      "<div>+44 7700 900123</div><br>",
      '<blockquote type="cite"><div>Divy Bramhecha</div><div>Old title</div></blockquote>',
    ].join("");
    const sent = [
      sentMail(["Sounds good.", "", "Cheers,", "Divy", "", ...block].join("\n"), html),
      sentMail(["Thursday works.", "", ...block].join("\n")),
    ];

    expect(learnSignature(sent)).toEqual({
      text: block.join("\n"),
      html:
        '<div>Divy Bramhecha</div><div style="color: #555">Product Engineer · <b>Northwind</b></div>' +
        "<div>+44 7700 900123</div>",
      images: [],
    });
  });

  it("takes a block the mail app marks as the signature, with its logo, and drops what can't come along", () => {
    const logo = { cid: "logo@x", filename: "logo.png", contentType: "image/png", content: jpeg };
    const html =
      "<p>Thursday works.</p>" +
      '<div id="Signature"><p>Divy Bramhecha</p><p><img src="cid:logo@x" onload="steal()"> Northwind</p>' +
      '<p><img src="http://tracker.example/pixel.gif"><a href="javascript:steal()">Site</a></p></div>' +
      '<div id="appendonsend"></div><div id="divRplyFwdMsg">From: Tess</div>';
    const sent: SentBody[] = [
      { text: ["Thursday works.", "", "Divy Bramhecha", "Northwind", "Site"].join("\n"), html, images: [logo] },
      sentMail(["Yes.", "", "Divy Bramhecha", "Northwind", "Site"].join("\n")),
    ];

    expect(learnSignature(sent)).toEqual({
      text: "Divy Bramhecha\nNorthwind\nSite",
      html: '<div id="Signature"><p>Divy Bramhecha</p><p><img src="cid:logo@x"> Northwind</p><p><a>Site</a></p></div>',
      images: [logo],
    });
  });
});
