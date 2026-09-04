CREATE TYPE "public"."file_relay_provider" AS ENUM('TELEGRAM_BOT', 'GOOGLE_DRIVE');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "file_relay_credentials" (
	"uuid" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"provider" "file_relay_provider" NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_relay_credentials_user_provider_idx" UNIQUE("user_id","provider")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "file_relay_credentials" ADD CONSTRAINT "file_relay_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "file_relay_credentials_user_id_idx" ON "file_relay_credentials" USING btree ("user_id");
