import { describe, expect, it } from "vitest";
import { hasAmount, isSubmitKey, judgeClick, type PageSignals } from "#browser/gate.ts";

// Where Kumo's hand stops, judged from a press's own words and what the page shows. These need no browser.

const calm: PageSignals = { payment: [], login: false, code: false, captcha: false };
const checkout: PageSignals = { ...calm, payment: ["card fields"] };

const button = (name: string) => ({ role: "button", name, text: name });

describe("the money gate", () => {
  it("refuses a press whose own words pay, whatever kind Kumo declares", () => {
    for (const words of ["Pay £42.00", "Place order", "Buy now", "Confirm and pay", "Complete purchase", "Pay later"]) {
      expect(judgeClick(button(words), "browse", calm)).toMatchObject({ kind: "money" });
    }
    expect(judgeClick({ role: "generic", name: "", text: "Place your order" }, "browse", calm)).toMatchObject({
      kind: "money",
    });
    expect(judgeClick(button("Book for £20"), "final", calm)).toMatchObject({ kind: "money" });
    expect(judgeClick(button("Next"), "payment", calm)).toEqual({
      kind: "money",
      why: "you said this step moves money",
    });
  });

  it("lets Kumo choose a fare, follow a link about payment, or book something free", () => {
    expect(judgeClick(button("£42 Standard"), "browse", calm)).toEqual({ kind: "browse" });
    expect(judgeClick({ role: "link", name: "Payment methods", text: "" }, "browse", calm)).toEqual({
      kind: "browse",
    });
    expect(judgeClick(button("Book for £0.00"), "browse", calm)).toEqual({ kind: "final" });
    expect(judgeClick(button("Confirm booking"), "browse", calm)).toEqual({ kind: "final" });
    expect(judgeClick(button("Show more times"), "browse", calm)).toEqual({ kind: "browse" });
  });

  it("treats committing or pressing on as money on a page that takes payment", () => {
    expect(judgeClick(button("Continue"), "browse", checkout)).toMatchObject({ kind: "money" });
    expect(judgeClick(button("Submit"), "browse", checkout)).toMatchObject({ kind: "money" });
    expect(judgeClick(button("Anything"), "final", checkout)).toMatchObject({ kind: "money" });
    expect(judgeClick({ role: "radio", name: "Next-day delivery", text: "" }, "browse", checkout)).toEqual({
      kind: "browse",
    });
    expect(judgeClick(button("Edit address"), "browse", checkout)).toEqual({ kind: "browse" });
  });

  it("knows a price from nothing, and Enter from other keys", () => {
    expect(hasAmount("Total €1,250.00")).toBe(true);
    expect(hasAmount("30 GBP")).toBe(true);
    expect(hasAmount("£0.00")).toBe(false);
    expect(hasAmount("Table for 2")).toBe(false);
    expect(isSubmitKey("Enter")).toBe(true);
    expect(isSubmitKey("Tab")).toBe(false);
  });
});
