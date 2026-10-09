import { assertEquals } from "@std/assert";
import {
  findRuleSpans,
  isValidAbn,
  isValidAcn,
  isValidMedicare,
  isValidTfn,
} from "../src/core/detect/rules.ts";

const found = (text: string) => findRuleSpans(text).map((s) => [s.label, s.text]);
const labels = (text: string) => findRuleSpans(text).map((s) => s.label);

Deno.test("checksums accept valid and reject invalid numbers", () => {
  assertEquals(isValidTfn("123 456 707"), true);
  assertEquals(isValidTfn("123 456 789"), false);
  assertEquals(isValidAbn("51 824 753 556"), true);
  assertEquals(isValidAbn("51 824 753 557"), false);
  assertEquals(isValidAcn("004 085 072"), true);
  assertEquals(isValidAcn("004 085 071"), false);
  assertEquals(isValidMedicare("2950 12348 1"), true);
  assertEquals(isValidMedicare("2950 12347 1"), false);
  assertEquals(isValidMedicare("7950 12348 1"), false);
});

Deno.test("email, mobile and landline numbers", () => {
  assertEquals(found("Email me at jo.bloggs+court@example.com.au today."), [[
    "email",
    "jo.bloggs+court@example.com.au",
  ]]);
  assertEquals(found("Call 0412 345 678."), [["phone_mobile", "0412 345 678"]]);
  assertEquals(found("Call +61 412 345 678"), [["phone_mobile", "+61 412 345 678"]]);
  assertEquals(found("Office (02) 4232 1234"), [["phone_landline", "(02) 4232 1234"]]);
  assertEquals(found("Office 02 4232 1234"), [["phone_landline", "02 4232 1234"]]);
});

Deno.test("checksummed identifiers are only flagged when valid", () => {
  assertEquals(labels("Medicare 2950 12348 1"), ["medicare"]);
  assertEquals(labels("TFN 123 456 707"), ["tfn"]);
  assertEquals(labels("Not a TFN 123 456 789"), []);
  assertEquals(labels("ABN 51 824 753 556"), ["abn"]);
  assertEquals(labels("ACN 004 085 072"), ["acn"]);
  assertEquals(labels("ACN 004 085 071").includes("acn"), false);
});

Deno.test("dates of birth are flagged but ordinary dates are not", () => {
  assertEquals(found("Mia was born 3 March 2017 in Sydney"), [["date_of_birth", "3 March 2017"]]);
  assertEquals(found("born on 21/09/2019"), [["date_of_birth", "21/09/2019"]]);
  assertEquals(found("DOB: 2019-09-21"), [["date_of_birth", "2019-09-21"]]);
  assertEquals(found("Date of birth is March 3, 2017"), [["date_of_birth", "March 3, 2017"]]);
  assertEquals(found("On 14 March 2025 he was late."), []);
  assertEquals(found("We separated on 21/09/2019."), []);
});

Deno.test("street addresses and suburb/state/postcode", () => {
  assertEquals(found("I live at 14 Banksia Crescent, Gerringong NSW 2534 with the children."), [
    ["street_address", "14 Banksia Crescent, Gerringong NSW 2534"],
  ]);
  assertEquals(found("Unit 3, 12-14 Smith St"), [["street_address", "Unit 3, 12-14 Smith St"]]);
  assertEquals(found("at 3/12 Old Princes Highway"), [[
    "street_address",
    "3/12 Old Princes Highway",
  ]]);
  assertEquals(found("moved to Figtree NSW 2525"), [["suburb_state_postcode", "Figtree NSW 2525"]]);
  assertEquals(found("He was 14 minutes late"), []);
});

Deno.test("court file numbers, BSB, accounts, licences and social profiles", () => {
  assertEquals(found("File number PAC1234/2024"), [["court_file_number", "PAC1234/2024"]]);
  assertEquals(found("File (P)SYC5678/2025"), [["court_file_number", "(P)SYC5678/2025"]]);
  assertEquals(labels("BSB 062-000 account number 1234 5678"), ["bsb", "account_number"]);
  assertEquals(found("licence number 12345678"), [["licence_or_passport", "12345678"]]);
  assertEquals(found("passport PA1234567"), [["licence_or_passport", "PA1234567"]]);
  assertEquals(found("see facebook.com/anna.t.99"), [[
    "social_profile_url",
    "facebook.com/anna.t.99",
  ]]);
});

Deno.test("no rule match crosses a line break", () => {
  const text = "I live at 14 Banksia\nCrescent, Gerringong NSW 2534\nphone 0412\n345 678";
  for (const s of findRuleSpans(text)) assertEquals(s.text.includes("\n"), false, s.text);
});

Deno.test("span offsets point at the matched text", () => {
  const text = "x DOB: 2019-09-21, email a@b.co";
  for (const s of findRuleSpans(text)) assertEquals(text.slice(s.start, s.end), s.text);
});
