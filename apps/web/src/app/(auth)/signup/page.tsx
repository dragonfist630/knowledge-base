"use client";

import { useActionState } from "react";
import Link from "next/link";

import { signup } from "../actions";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function SignupPage() {
  const [state, formAction, pending] = useActionState(signup, undefined);

  if (state?.message) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Check your email</CardTitle>
          <CardDescription>{state.message}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create an account</CardTitle>
        <CardDescription>Sign up to start building your Knowledge Base.</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-col gap-6">
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input id="email" name="email" type="email" autoComplete="email" placeholder="you@example.com" aria-invalid={!!state?.errors?.email} required />
            {state?.errors?.email && <p className="text-sm text-destructive">{state.errors.email[0]}</p>}
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input id="password" name="password" type="password" autoComplete="new-password" aria-invalid={!!state?.errors?.password} required />
            {state?.errors?.password ? (
              <p className="text-sm text-destructive">{state.errors.password[0]}</p>
            ) : (
              <p className="text-muted-foreground text-xs">At least 8 characters.</p>
            )}
          </div>
          {state?.errors?.form && <p className="text-sm text-destructive">{state.errors.form[0]}</p>}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Creating account…" : "Sign up"}
          </Button>
          <div className="text-center text-sm">
            Already have an account?{" "}
            <Link href="/login" className="underline underline-offset-4">
              Sign in
            </Link>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
