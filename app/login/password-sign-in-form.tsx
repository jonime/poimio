"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { signInWithPassword } from "../auth/actions";

export function PasswordSignInForm() {
  const [error, formAction, pending] = useActionState(signInWithPassword, null);

  return (
    <form action={formAction} aria-busy={pending}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            maxLength={254}
            required
          />
        </Field>
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            maxLength={4096}
            aria-invalid={error ? true : undefined}
            required
          />
          {error && <FieldError>{error}</FieldError>}
        </Field>
        <Field>
          <Button type="submit" disabled={pending}>
            {pending && <Spinner data-icon="inline-start" />}
            {pending ? "Signing in..." : "Sign in with email"}
          </Button>
        </Field>
      </FieldGroup>
    </form>
  );
}
