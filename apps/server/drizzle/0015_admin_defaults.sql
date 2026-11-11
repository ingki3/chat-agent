ALTER TABLE `users` ADD `initial_defaults` text;--> statement-breakpoint
ALTER TABLE `users` ADD `defaults` text;--> statement-breakpoint
UPDATE `users` SET `initial_defaults` = json_object('runtime', `default_runtime`, 'models', json_object()) WHERE `default_runtime` IN ('claude-code', 'codex');
