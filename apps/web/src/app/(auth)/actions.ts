"use server";

import { redirect } from "next/navigation";

import { AuthCredentialsSchema, type AuthFormState } from "@/lib/auth/schema";
import { createClient } from "@/lib/supabase/server";

export async function login(_prevState: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const validated = AuthCredentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!validated.success) {
    return { errors: validated.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(validated.data);
  if (error) {
    return { errors: { form: [error.message] } };
  }

  const redirectTo = formData.get("redirectTo");
  redirect(typeof redirectTo === "string" && redirectTo.startsWith("/") ? redirectTo : "/documents");
}

export async function signup(_prevState: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const validated = AuthCredentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!validated.success) {
    return { errors: validated.error.flatten().fieldErrors };
  }

  const supabase = await createClient();
  const origin = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const { data, error } = await supabase.auth.signUp({
    ...validated.data,
    options: { emailRedirectTo: `${origin}/auth/callback` },
  });
  if (error) {
    return { errors: { form: [error.message] } };
  }

  // Local dev (and most demo Supabase projects) has email confirmation
  // disabled, so signUp already returns a live session — go straight in.
  // A project with confirmation ON returns a user but no session; tell
  // the visitor to check their inbox instead of redirecting them into a
  // route the proxy will just bounce them out of.
  if (data.session) {
    redirect("/documents");
  }
  return { message: "Check your email to confirm your account before signing in." };
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}
