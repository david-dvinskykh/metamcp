ALTER TABLE "oauth_authorization_codes" ADD COLUMN IF NOT EXISTS "namespace_uuid" uuid;--> statement-breakpoint
ALTER TABLE "oauth_access_tokens" ADD COLUMN IF NOT EXISTS "namespace_uuid" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_authorization_codes" ADD CONSTRAINT "oauth_authorization_codes_namespace_uuid_namespaces_uuid_fk" FOREIGN KEY ("namespace_uuid") REFERENCES "public"."namespaces"("uuid") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_namespace_uuid_namespaces_uuid_fk" FOREIGN KEY ("namespace_uuid") REFERENCES "public"."namespaces"("uuid") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "oauth_access_tokens_namespace_uuid_idx" ON "oauth_access_tokens" USING btree ("namespace_uuid");
