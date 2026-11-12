CREATE TABLE `connection_limits` (
	`connection_id` text NOT NULL,
	`scope` text NOT NULL,
	`until` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`connection_id`, `scope`),
	FOREIGN KEY (`connection_id`) REFERENCES `connections`(`id`) ON UPDATE no action ON DELETE cascade
);
