ALTER TABLE `conversations` ADD `runtime` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `model` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `use_shared` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `conversations` ADD `fallback_notice` text;--> statement-breakpoint
UPDATE `conversations` SET `runtime` = (SELECT m.`runtime` FROM `messages` m WHERE m.`conversation_id` = `conversations`.`id` AND m.`active` = 1 AND m.`role` = 'assistant' AND m.`runtime` IN ('claude-code', 'codex') AND m.`model` IS NOT NULL ORDER BY m.`seq` DESC LIMIT 1);--> statement-breakpoint
UPDATE `conversations` SET `model` = (SELECT m.`model` FROM `messages` m WHERE m.`conversation_id` = `conversations`.`id` AND m.`active` = 1 AND m.`role` = 'assistant' AND m.`runtime` = `conversations`.`runtime` AND m.`model` IS NOT NULL ORDER BY m.`seq` DESC LIMIT 1), `effort` = (SELECT m.`effort` FROM `messages` m WHERE m.`conversation_id` = `conversations`.`id` AND m.`active` = 1 AND m.`role` = 'assistant' AND m.`runtime` = `conversations`.`runtime` AND m.`model` IS NOT NULL ORDER BY m.`seq` DESC LIMIT 1) WHERE `runtime` IS NOT NULL;
