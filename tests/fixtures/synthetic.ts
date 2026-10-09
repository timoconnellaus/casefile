/**
 * SYNTHETIC test data only. Every name, address and number here is invented.
 * Identifier numbers are checksum-valid so the rules treat them as real.
 * Real case documents must never be added to this repository (ADR 0011).
 */
import type { Detector, Span } from "../../src/core/detect/types.ts";
import type { EntityKind } from "../../src/core/entities.ts";

export const PEOPLE = {
  mother: "Anna Thornbury",
  father: "Daniel Okafor",
  child1: "Mia Okafor",
  child2: "Lachlan Okafor",
  school: "Kiama Downs Public School",
  childcare: "Little Gumnuts Childcare",
};

export const IDS = {
  address: "14 Banksia Crescent, Gerringong NSW 2534",
  mobile: "0412 345 678",
  email: "anna.thornbury@example.com.au",
  medicare: "2950 12348 1",
  tfn: "123 456 707",
  abn: "51 824 753 556",
  dob1: "3 March 2017",
  dob2: "21/09/2019",
  fileNo: "PAC1234/2024",
};

export const AFFIDAVIT_TITLE = "Affidavit of Anna Thornbury";

export const AFFIDAVIT = `AFFIDAVIT
Federal Circuit and Family Court of Australia — File number ${IDS.fileNo}

I, Anna Thornbury, of ${IDS.address}, say on oath:

1. I am the mother of Mia Okafor, born ${IDS.dob1}, and Lachlan Okafor, born on ${IDS.dob2}.
2. The father of the children is Daniel Okafor. Mr Okafor and I separated in June 2023.
3. Mia attends Kiama Downs Public School. Lachlan attends Little Gumnuts Childcare.
4. On 14 March 2025 Daniel collected the children 90 minutes late from Kiama Downs Public School.
5. I can be contacted on ${IDS.mobile} or ${IDS.email}.
6. My Medicare number is ${IDS.medicare} and my tax file number is ${IDS.tfn}.
7. Daniel's business, Okafor Joinery (ABN ${IDS.abn}), operates from the same address.
`;

export const MESSAGES_TITLE = "Text messages March 2025";

export const MESSAGES =
  `14/03/2025 3:05pm Anna: Where are you? Mia has been waiting at school since 3.
14/03/2025 4:31pm Daniel: Traffic. Got them now.
15/03/2025 9:12am Anna: Mr Okafor, this is the third time this term.
15/03/2025 9:40am Daniel: Mia said she was fine. Stop making a big deal Anna.
`;

/** Every string that must never appear in public.db. */
export const SECRETS: string[] = [
  "Anna",
  "Thornbury",
  "Daniel",
  "Okafor",
  "Lachlan",
  "Kiama Downs",
  "Gumnuts",
  "Banksia",
  "Gerringong",
  "0412 345 678",
  "anna.thornbury",
  "2950 12348 1",
  "123 456 707",
  "51 824 753 556",
  "3 March 2017",
  "21/09/2019",
  "PAC1234",
];

/**
 * Stands in for the NER/LLM detectors in tests: finds the listed strings wherever they occur.
 * It is deliberately imperfect (finds each string's first occurrence only) so the pipeline's
 * "search everywhere" propagation is exercised.
 */
export class FakeNameDetector implements Detector {
  readonly name = "fake-ner";
  readonly findsNames = true;
  constructor(private names: { text: string; kind: EntityKind; roleHint?: string }[]) {}
  detect(text: string): Promise<Span[]> {
    const spans: Span[] = [];
    for (const n of this.names) {
      const i = text.indexOf(n.text);
      if (i !== -1) {
        spans.push({
          start: i,
          end: i + n.text.length,
          text: n.text,
          kind: n.kind,
          source: "ner",
          confidence: 0.9,
          roleHint: n.roleHint,
        });
      }
    }
    return Promise.resolve(spans);
  }
}

export const FAKE_NER_NAMES: { text: string; kind: EntityKind; roleHint?: string }[] = [
  { text: "Anna Thornbury", kind: "person", roleHint: "mother" },
  { text: "Daniel Okafor", kind: "person", roleHint: "father" },
  { text: "Mia Okafor", kind: "person", roleHint: "child_1" },
  { text: "Lachlan Okafor", kind: "person", roleHint: "child_2" },
  { text: "Kiama Downs Public School", kind: "school", roleHint: "school" },
  { text: "Little Gumnuts Childcare", kind: "organisation", roleHint: "childcare" },
  { text: "Okafor Joinery", kind: "organisation", roleHint: "father_business" },
];

export class FailingDetector implements Detector {
  readonly name = "broken";
  detect(): Promise<Span[]> {
    return Promise.reject(new Error("model not available"));
  }
}

export async function tempDir(prefix = "casefile-test-"): Promise<string> {
  return await Deno.makeTempDir({ prefix });
}
