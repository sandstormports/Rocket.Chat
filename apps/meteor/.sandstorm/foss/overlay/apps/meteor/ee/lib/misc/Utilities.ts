// SANDSTORM-FOSS-STUB (MIT). Helpers used by the apps UI and the Apps-Engine bridges.
export class Utilities {
	static getI18nKeyForApp<TKey extends string, TAppId extends string>(key: TKey, appId: TAppId) {
		return `app-${appId}.${key}` as const;
	}

	static curl({
		method,
		params,
		auth,
		headers = {},
		url,
		query,
		content,
	}: {
		method: string;
		params?: Record<string, string>;
		auth?: string;
		headers?: Record<string, string>;
		url: string;
		query?: Record<string, string>;
		content?: unknown;
	}): string {
		let target = url;
		for (const [name, value] of Object.entries(params ?? {})) {
			target = target.replace(`:${name}`, encodeURIComponent(value));
		}
		if (query && Object.keys(query).length) {
			target += `?${new URLSearchParams(query).toString()}`;
		}
		const parts = [`curl -X ${method.toUpperCase()} '${target}'`];
		if (auth) {
			parts.push(`-u '${auth}'`);
		}
		for (const [name, value] of Object.entries(headers)) {
			parts.push(`-H '${name}: ${value}'`);
		}
		if (content !== undefined) {
			parts.push(`-d '${typeof content === 'string' ? content : JSON.stringify(content)}'`);
		}
		return parts.join(' \\\n   ');
	}
}
