// Representation format is chosen via the Accept header (spec §2), not a ?format= param.

/** True if the client accepts text/csv. */
export function wantsCsv(accept: string | null | undefined): boolean {
  if (!accept) return false;
  return accept
    .split(",")
    .some((part) => part.trim().split(";")[0].trim().toLowerCase() === "text/csv");
}
