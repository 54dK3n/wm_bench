CREATE TABLE `competition_admin_credentials` (
	`id` integer PRIMARY KEY NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "competition_admin_credentials_singleton_check" CHECK("competition_admin_credentials"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `competition_admin_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`admin_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`admin_id`) REFERENCES `competition_admin_credentials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `competition_admin_sessions_expires_idx` ON `competition_admin_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `competition_evaluation_sets` (
	`division` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`version` text NOT NULL,
	`sample_count` integer NOT NULL,
	`labels_json` text NOT NULL,
	`embedding_size` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "competition_evaluation_sets_division_check" CHECK("competition_evaluation_sets"."division" in ('primary', 'junior', 'senior')),
	CONSTRAINT "competition_evaluation_sets_sample_count_check" CHECK("competition_evaluation_sets"."sample_count" >= 0),
	CONSTRAINT "competition_evaluation_sets_embedding_size_check" CHECK("competition_evaluation_sets"."embedding_size" > 0)
);
--> statement-breakpoint
CREATE TABLE `competition_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `competition_teams`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `competition_sessions_team_idx` ON `competition_sessions` (`team_id`);--> statement-breakpoint
CREATE INDEX `competition_sessions_expires_idx` ON `competition_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `competition_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`artifact_key` text,
	`artifact_sha256` text,
	`artifact_bytes` integer,
	`status` text NOT NULL,
	`score_micros` integer,
	`correct_count` integer,
	`total_count` integer,
	`metrics_json` text,
	`evaluation_version` text,
	`model_name` text,
	`submitted_at` integer NOT NULL,
	`scored_at` integer,
	`error_message` text,
	`idempotency_key` text NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `competition_teams`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "competition_submissions_status_check" CHECK("competition_submissions"."status" in ('pending', 'uploaded', 'evaluating', 'scored', 'failed', 'rejected')),
	CONSTRAINT "competition_submissions_artifact_bytes_check" CHECK("competition_submissions"."artifact_bytes" is null or "competition_submissions"."artifact_bytes" >= 0),
	CONSTRAINT "competition_submissions_score_check" CHECK("competition_submissions"."score_micros" is null or "competition_submissions"."score_micros" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `competition_submissions_team_idempotency_unique` ON `competition_submissions` (`team_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `competition_submissions_team_time_idx` ON `competition_submissions` (`team_id`,`submitted_at`);--> statement-breakpoint
CREATE INDEX `competition_submissions_status_idx` ON `competition_submissions` (`status`);--> statement-breakpoint
CREATE TABLE `competition_teams` (
	`id` text PRIMARY KEY NOT NULL,
	`team_name` text NOT NULL,
	`team_name_key` text NOT NULL,
	`division` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`latest_submission_id` text,
	CONSTRAINT "competition_teams_division_check" CHECK("competition_teams"."division" in ('primary', 'junior', 'senior'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `competition_teams_team_name_key_unique` ON `competition_teams` (`team_name_key`);--> statement-breakpoint
CREATE INDEX `competition_teams_latest_submission_idx` ON `competition_teams` (`latest_submission_id`);