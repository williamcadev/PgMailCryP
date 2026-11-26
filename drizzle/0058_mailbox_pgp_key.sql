CREATE TABLE `mailbox_pgp_key` (
	`mailbox_id` text PRIMARY KEY NOT NULL REFERENCES `mailbox`(`id`) ON DELETE CASCADE,
	`public_key_armored` text NOT NULL,
	`fingerprint` text NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
