CREATE TABLE `file_extracts` (
	`file_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`code` text,
	`ocr` text DEFAULT 'none' NOT NULL,
	`units` integer,
	`segments` integer DEFAULT 0 NOT NULL,
	`characters` integer DEFAULT 0 NOT NULL,
	`truncated` integer DEFAULT false NOT NULL,
	`ended_early` integer DEFAULT false NOT NULL,
	`extractor` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `file_segments` (
	`file_id` text NOT NULL,
	`seq` integer NOT NULL,
	`unit` integer NOT NULL,
	`locator` text NOT NULL,
	`text` text NOT NULL,
	`marks` text,
	`approximate` integer DEFAULT false NOT NULL,
	`cut` integer DEFAULT false NOT NULL,
	`ends_early` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`file_id`, `seq`),
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `file_segments_unit_idx` ON `file_segments` (`file_id`,`unit`);--> statement-breakpoint
ALTER TABLE `citations` ADD `file_id` text;--> statement-breakpoint
ALTER TABLE `citations` ADD `locator` text;