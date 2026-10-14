// SANDSTORM-FOSS-STUB (MIT). Canned responses are an Enterprise feature; messages pass through unchanged.
export class BeforeSaveCannedResponse {
	static enabled = false;

	async replacePlaceholders<T>({ message }: { message: T; room?: unknown; user?: unknown }): Promise<T> {
		return message;
	}
}
