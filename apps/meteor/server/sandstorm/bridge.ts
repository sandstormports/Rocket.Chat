import { createRequire } from 'node:module';

export type SandstormActivity = {
	path: string;
	// Index of the event type in sandstorm-pkgdef.capnp's bridgeConfig.viewInfo.eventTypes.
	type: number;
	caption?: string;
	users: { id: string; mentioned?: boolean }[];
};

export type SandstormGrain = {
	token: string;
	title: string;
	appTitle?: string;
	appIconUrl?: string;
};

type SandstormBridge = {
	reportActivity(sessionId: string, activity: SandstormActivity): Promise<void>;
	claimUiView(sessionId: string, requestToken: string, descriptor: string, label: string): Promise<SandstormGrain>;
	offerUiView(sessionId: string, token: string, title: string): Promise<void>;
};

let bridge: SandstormBridge | undefined;

// Cap'n Proto client for sandstorm-http-bridge's API socket. It ships with the
// grain rather than the bundle (.sandstorm/bridge), and the launcher says where.
export const getSandstormBridge = (): SandstormBridge => {
	if (!bridge) {
		const modulePath = process.env.SANDSTORM_BRIDGE_MODULE;
		if (!modulePath) {
			throw new Error('SANDSTORM_BRIDGE_MODULE is not set');
		}
		bridge = (createRequire(modulePath)(modulePath) as { createBridge(): SandstormBridge }).createBridge();
	}
	return bridge;
};
