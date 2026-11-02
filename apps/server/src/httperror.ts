// An answer other than 200, with its status and detail. Kept apart from pages.ts, which imports most of the server,
// so a module low in the graph (seat.ts, which models.ts imports) can throw one without an import cycle.
export class HttpError extends Error {
  status: number;
  detail: unknown; // what the answer's "detail" says: the message, or FastAPI's list for a field left out
  constructor(status: number, detail: string, shaped?: unknown) {
    super(detail);
    this.status = status;
    this.detail = shaped ?? detail;
  }
}
