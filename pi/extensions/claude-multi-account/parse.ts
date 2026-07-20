// Byte-exact locator for a TOP-LEVEL string field of a JSON object.
// Ported from teamclaude (MIT). It tracks JSON structure (container stack,
// key/value, string/escape) so it ONLY matches the field at depth 1 of the root
// object — a `"model": "..."` sitting inside conversation text (a message, a
// tool result) is nested deeper and is never mistaken for the real field.
// We have the whole body in hand, but a full JSON.parse of a multi-hundred-KB
// request on every call is wasteful; this stops as soon as the field resolves.
class TopLevelFieldFinder {
	private field: string;
	private isObj: boolean[] = [];
	private awaitingKey = false;
	private inStr = false;
	private esc = false;
	private readingKey = false;
	private readingValue = false;
	private curKey: string | null = null;
	private buf: number[] = [];
	value: string | null = null;
	done = false;

	constructor(field: string) {
		this.field = field;
	}

	push(chunk: Uint8Array): string | null {
		if (this.done) return this.value;
		for (let i = 0; i < chunk.length && !this.done; i++) this.byte(chunk[i]);
		return this.value;
	}

	private atRoot(): boolean {
		return this.isObj.length === 1 && this.isObj[0] === true;
	}

	private byte(b: number): void {
		if (this.inStr) {
			if (this.esc) {
				this.esc = false;
				if (this.readingKey || this.readingValue) this.buf.push(b);
				return;
			}
			if (b === 0x5c) {
				this.esc = true;
				if (this.readingKey || this.readingValue) this.buf.push(b);
				return;
			}
			if (b === 0x22) {
				this.inStr = false;
				if (this.readingKey) {
					this.curKey = Buffer.from(this.buf).toString("utf8");
					this.buf = [];
					this.readingKey = false;
				} else if (this.readingValue) {
					this.value = Buffer.from(this.buf).toString("utf8");
					this.buf = [];
					this.readingValue = false;
					this.done = true;
				}
				return;
			}
			if (this.readingKey || this.readingValue) this.buf.push(b);
			return;
		}

		switch (b) {
			case 0x7b: // {
				this.isObj.push(true);
				this.awaitingKey = true;
				this.curKey = null;
				break;
			case 0x5b: // [
				this.isObj.push(false);
				this.awaitingKey = false;
				break;
			case 0x7d: // }
			case 0x5d: // ]
				this.isObj.pop();
				this.curKey = null;
				if (this.isObj.length === 0) this.done = true;
				break;
			case 0x3a: // :
				this.awaitingKey = false;
				break;
			case 0x2c: // ,
				this.awaitingKey = this.isObj[this.isObj.length - 1] === true;
				break;
			case 0x22: // "
				if (this.awaitingKey && this.isObj[this.isObj.length - 1]) {
					this.readingKey = true;
					this.buf = [];
				} else if (this.atRoot() && this.curKey === this.field) {
					this.readingValue = true;
					this.buf = [];
				}
				this.inStr = true;
				this.esc = false;
				break;
			default:
				break;
		}
	}
}

/** Extract the top-level `model` id from a JSON request body. Null if absent. */
export function parseRequestModel(
	body: string | undefined | null,
): string | null {
	if (!body) return null;
	try {
		const buf = Buffer.from(body, "utf8");
		return new TopLevelFieldFinder("model").push(buf);
	} catch {
		return null;
	}
}
