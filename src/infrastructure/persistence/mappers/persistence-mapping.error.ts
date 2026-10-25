/** A stored row that cannot be turned back into a domain object: corrupted data or a mapper bug. */
export class PersistenceMappingError extends Error {
  override readonly name = "PersistenceMappingError";
}
