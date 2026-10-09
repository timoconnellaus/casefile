/** Entity kinds. Kept apart from the registry so the CLI can use the type without importing it. */
export const ENTITY_KINDS = [
  "person",
  "place",
  "organisation",
  "school",
  "address",
  "phone",
  "email",
  "identifier",
  "date_of_birth",
  "other",
] as const;
export type EntityKind = typeof ENTITY_KINDS[number];
