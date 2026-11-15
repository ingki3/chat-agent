ALTER TABLE `connections` ADD `credential_base_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `connections` ADD `account_email` text;--> statement-breakpoint
-- Existing credentials were set by a person at their current version (#18: refreshes keep the base).
UPDATE `connections` SET `credential_base_version` = `credential_version`;
