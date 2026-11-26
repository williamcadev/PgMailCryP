CREATE TABLE `pgp_draft` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`user_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pgp_draft_owner_idx` ON `pgp_draft` (`user_id`,`mailbox_id`);--> statement-breakpoint
CREATE TABLE `pgp_outbox_message` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`user_id` text NOT NULL,
	`from_address` text NOT NULL,
	`r2_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`envelope_recipients` text NOT NULL,
	`prepared` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pgp_outbox_mailbox_created_idx` ON `pgp_outbox_message` (`mailbox_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `pgp_outbox_recipient` (
	`submission_id` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`address` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_attempt_at` integer,
	`next_attempt_at` integer,
	`error_code` text,
	FOREIGN KEY (`submission_id`) REFERENCES `pgp_outbox_message`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pgp_outbox_recipient_uidx` ON `pgp_outbox_recipient` (`submission_id`,`address`);--> statement-breakpoint
CREATE INDEX `pgp_outbox_retry_idx` ON `pgp_outbox_recipient` (`status`,`next_attempt_at`);