import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { createCell } from "#cell.ts";

// A small made-up website for the browser's tests, served from the test itself: a restaurant to book, a shop that
// takes payment, a bank to sign in to, a form in steps, files to upload and download, and a page to touch. Every name
// in it is fictional, and no test ever reaches a real website.

export type Booking = { readonly name: string; readonly guests: string; readonly day: string; readonly time: string };

export type Site = {
  readonly origin: string;
  readonly bookings: () => readonly Booking[];
  readonly payments: () => number;
  readonly close: () => Promise<void>;
};

const page = (title: string, body: string, site = "Fixture Kitchen"): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta property="og:site_name" content="${site}"><title>${title}</title>
<style>body{font:16px system-ui;margin:16px} button,.button{font-size:18px;padding:10px;margin:4px}</style>
</head><body>${body}</body></html>`;

const bookingForm = (action: string): string =>
  page(
    "Book a table",
    `<h1>Book a table</h1>
<form method="post" action="${action}">
  <label>Name <input name="name"></label>
  <label>Guests <select name="guests"><option>1</option><option selected>2</option><option>3</option></select></label>
  <div role="group" aria-label="Day">
    <button type="button" aria-pressed="false" data-day="Fri 27">Fri 27</button>
    <button type="button" aria-pressed="false" data-day="Sat 28">Sat 28</button>
  </div>
  <input type="hidden" name="day" value="">
  <label>Time <select name="time"><option>19:00</option><option>19:30</option><option>20:00</option></select></label>
  <p>Deposit: none</p><p id="screen"></p>
  <button type="submit">Book now</button>
</form>
<p><a href="/bookings">Your bookings</a></p>
<script>
document.getElementById("screen").textContent =
  "Screen " + innerWidth + " wide" + (navigator.maxTouchPoints > 0 ? ", touch" : "") + (/iPhone/.test(navigator.userAgent) ? ", iPhone" : "");
for (const button of document.querySelectorAll("[data-day]")) {
  button.addEventListener("click", () => {
    for (const other of document.querySelectorAll("[data-day]")) other.setAttribute("aria-pressed", String(other === button));
    document.querySelector("[name=day]").value = button.dataset.day;
  });
}
</script>`,
  );

const checkout = page(
  "Checkout",
  `<h1>Checkout</h1>
<p>Notebook, £42.00</p><p>Order total: £42.00</p>
<form method="post" action="/pay">
  <label>Card number <input name="card" autocomplete="cc-number"></label>
  <label>Expiry <input name="expiry" autocomplete="cc-exp"></label>
  <label>Gift note <input name="note"></label>
  <button type="button">Continue</button>
  <button type="submit">Pay £42.00</button>
  <div class="button" onclick="this.closest('form').submit()" style="cursor:pointer">Place order</div>
</form>`,
  "Fixture Shop",
);

const login = page(
  "Sign in",
  `<h1>Sign in to Fixture Bank</h1>
<form method="post" action="/login">
  <label>Email <input name="email" type="email" autocomplete="username"></label>
  <label>Password <input name="password" type="password" autocomplete="current-password"></label>
  <button type="submit">Sign in</button>
</form>`,
  "Fixture Bank",
);

const wizard = page(
  "Apply",
  `<h1 id="heading">Step 1 of 2: you</h1>
<form id="form" method="post" action="/apply">
  <div id="one"><label>Full name <input name="full"></label><button type="button" id="next">Next</button></div>
  <div id="two" hidden><label>Reason <input name="reason"></label><button type="submit">Submit application</button></div>
</form>
<script>
document.getElementById("next").addEventListener("click", () => {
  document.getElementById("one").remove();
  document.getElementById("two").hidden = false;
  document.getElementById("heading").textContent = "Step 2 of 2: why";
});
</script>`,
  "Fixture Council",
);

const renaming = page(
  "Renaming",
  `<h1>Renaming</h1><button id="target">Book</button><button id="change">Change it</button><p id="said"></p>
<script>
document.getElementById("change").addEventListener("click", () => { document.getElementById("target").textContent = "Book now"; });
document.getElementById("target").addEventListener("click", () => { document.getElementById("said").textContent = "Pressed"; });
</script>`,
);

const touch = page(
  "Touch",
  `<style>#pad{position:fixed;inset:0;background:rgb(0,0,255)} #pad.on{background:rgb(255,0,0)}
#spin{position:fixed;left:20px;bottom:20px;width:60px;height:60px;background:#0f0;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}} input{position:fixed;top:300px;left:20px;font-size:20px}</style>
<div id="pad"></div><input id="field" aria-label="Note" autocomplete="one-time-code"><div id="spin" hidden></div>
<script>
const pad = document.getElementById("pad");
pad.addEventListener("touchstart", () => { pad.classList.toggle("on"); });
addEventListener("keydown", (event) => { if (event.key === "Escape") document.getElementById("spin").hidden = false; });
</script>`,
);

const files = page(
  "Files",
  `<h1>Visa photo</h1>
<form><label>Photo <input type="file" name="photo" id="photo"></label></form><p id="chosen">Nothing chosen</p>
<p><a href="/files/menu.txt" download>Menu</a></p>
<script>
document.getElementById("photo").addEventListener("change", (event) => {
  document.getElementById("chosen").textContent = "Chosen: " + [...event.target.files].map((file) => file.name).join(", ");
});
</script>`,
);

const readBody = async (request: IncomingMessage): Promise<URLSearchParams> => {
  const collect = async (iterator: AsyncIterator<Buffer>, chunks: readonly Buffer[]): Promise<readonly Buffer[]> => {
    const next = await iterator.next();
    return next.done === true ? chunks : collect(iterator, [...chunks, next.value]);
  };
  const chunks = await collect((request as AsyncIterable<Buffer>)[Symbol.asyncIterator](), []);
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
};

const send = (response: ServerResponse, status: number, body: string): void => {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
};

const redirect = (response: ServerResponse, location: string, headers: Record<string, string> = {}): void => {
  response.writeHead(303, { location, ...headers });
  response.end();
};

export const startSite = async (): Promise<Site> => {
  const bookings = createCell<readonly Booking[]>([]);
  const payments = createCell(0);
  const sockets = createCell<ReadonlySet<Socket>>(new Set());

  const book = async (request: IncomingMessage): Promise<Booking> => {
    const form = await readBody(request);
    const booking = {
      name: form.get("name") ?? "",
      guests: form.get("guests") ?? "",
      day: form.get("day") ?? "",
      time: form.get("time") ?? "",
    };
    bookings.update((current) => [...current, booking]);
    return booking;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const url = new URL(request.url ?? "/", "http://fixture.test");
    const route = `${request.method ?? "GET"} ${url.pathname}`;
    switch (route) {
      case "GET /book": {
        send(response, 200, bookingForm("/book"));
        return;
      }
      case "GET /book-slow": {
        send(response, 200, bookingForm("/book-hang"));
        return;
      }
      case "POST /book": {
        const booking = await book(request);
        redirect(response, `/booked?name=${encodeURIComponent(booking.name)}`);
        return;
      }
      case "POST /book-hang": {
        // The booking goes through, and the answer never comes back.
        await book(request);
        return;
      }
      case "GET /booked": {
        send(response, 200, page("Booked", `<h1>Booked</h1><p>Thanks, ${url.searchParams.get("name") ?? ""}.</p>`));
        return;
      }
      case "GET /bookings": {
        const rows = bookings
          .get()
          .map(({ name, guests, day, time }) => `<li>${name}, ${guests} guests, ${day} ${time}</li>`)
          .join("");
        send(response, 200, page("Your bookings", `<h1>Your bookings</h1><ul>${rows || "<li>None yet</li>"}</ul>`));
        return;
      }
      case "GET /checkout": {
        send(response, 200, checkout);
        return;
      }
      case "POST /pay": {
        payments.update((count) => count + 1);
        send(response, 200, page("Paid", "<h1>Paid</h1>", "Fixture Shop"));
        return;
      }
      case "GET /login": {
        send(response, 200, login);
        return;
      }
      case "POST /login": {
        const form = await readBody(request);
        const email = form.get("email") ?? "";
        const isRight = form.get("password") === "correct horse";
        if (!isRight) {
          send(response, 401, login);
          return;
        }
        redirect(response, "/account", {
          "set-cookie": `session=${encodeURIComponent(email)}; Max-Age=31536000; Path=/; HttpOnly`,
        });
        return;
      }
      case "GET /account": {
        const cookie = /session=(?<email>[^;]+)/u.exec(request.headers.cookie ?? "")?.groups?.email;
        if (cookie === undefined) {
          redirect(response, "/login");
          return;
        }
        send(response, 200, page("Account", `<h1>Signed in as ${decodeURIComponent(cookie)}</h1>`, "Fixture Bank"));
        return;
      }
      case "GET /apply": {
        send(response, 200, wizard);
        return;
      }
      case "POST /apply": {
        send(response, 200, page("Applied", "<h1>Application sent</h1>", "Fixture Council"));
        return;
      }
      case "GET /renaming": {
        send(response, 200, renaming);
        return;
      }
      case "GET /touch": {
        send(response, 200, touch);
        return;
      }
      case "GET /files": {
        send(response, 200, files);
        return;
      }
      case "GET /files/menu.txt": {
        response.writeHead(200, {
          "content-type": "text/plain",
          "content-disposition": 'attachment; filename="menu.txt"',
        });
        response.end("Soup of the day\n");
        return;
      }
      default: {
        send(response, 404, page("Not found", "<h1>Not found</h1>"));
      }
    }
  };

  const server = createServer((request, response) => {
    void handle(request, response);
  });
  server.on("connection", (socket) => {
    sockets.update((current) => new Set([...current, socket]));
    socket.on("close", () => {
      sockets.update((current) => new Set([...current].filter((candidate) => candidate !== socket)));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    bookings: () => bookings.get(),
    payments: () => payments.get(),
    close: async () => {
      for (const socket of sockets.get()) socket.destroy();
      server.close();
      await once(server, "close");
    },
  };
};
