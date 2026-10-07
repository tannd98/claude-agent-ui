/** One frontmatter (or body) problem, named by the field it belongs to. */
export interface FieldError {
  /** A frontmatter key (`name`, `description`), or `frontmatter`/`content` for whole-file problems. */
  field: string;
  message: string;
}

/**
 * Anything the caller can fix by changing its request.
 *
 * `fields` is what makes a frontmatter 400 actionable: the editor highlights the offending key
 * instead of showing one opaque sentence. It is empty for errors that are not about a field.
 */
export class ValidationError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly fields: FieldError[] = [],
  ) {
    super(message);
  }
}
