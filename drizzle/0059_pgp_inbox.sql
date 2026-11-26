CREATE TABLE `pgp_inbox_message` (
	`id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`r2_key` text NOT NULL,
	`received_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailbox`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pgp_inbox_mailbox_id_uidx` ON `pgp_inbox_message` (`mailbox_id`,`id`);--> statement-breakpoint
CREATE INDEX `pgp_inbox_mailbox_received_idx` ON `pgp_inbox_message` (`mailbox_id`,`received_at`);