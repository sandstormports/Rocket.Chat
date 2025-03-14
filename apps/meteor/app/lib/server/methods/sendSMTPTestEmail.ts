import { Meteor } from 'meteor/meteor';
import { DDPRateLimiter } from 'meteor/ddp-rate-limiter';
import type { ServerMethods } from '@rocket.chat/ui-contexts';

import * as Mailer from '../../../mailer/server/api';
import { settings } from '../../../settings/server';

declare module '@rocket.chat/ui-contexts' {
	// eslint-disable-next-line @typescript-eslint/naming-convention
	interface ServerMethods {
		sendSMTPTestEmail(): {
			message: string;
			params: string[];
		};
	}
}

Meteor.methods<ServerMethods>({
	sendSMTPTestEmail() {
		if (!Meteor.userId()) {
			throw new Meteor.Error('error-invalid-user', 'Invalid user', {
				method: 'sendSMTPTestEmail',
			});
		}
		const user = Meteor.user();
		if (!user?.emails?.[0]?.address) {
			throw new Meteor.Error('error-invalid-email', 'Invalid email', {
				method: 'sendSMTPTestEmail',
			});
		}
		try {
			Mailer.send({
				to: user.emails[0].address,
				from: settings.get('From_Email'),
				subject: 'SMTP Test Email',
				html: '<p>You have successfully sent an email</p>',
			});
		} catch ({ message }) {
			throw new Meteor.Error('error-email-send-failed', `Error trying to send email: ${message}`, {
				method: 'sendSMTPTestEmail',
				message,
			});
		}
		return {
			message: 'Sending_your_mail_to_s',
			params: [user.emails[0].address],
		};
	},
});

DDPRateLimiter.addRule(
	{
		type: 'method',
		name: 'sendSMTPTestEmail',
		userId() {
			return true;
		},
	},
	1,
	1000,
);
