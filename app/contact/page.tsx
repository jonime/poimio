import type { Metadata } from "next";
import Link from "next/link";
import { PublicInfoPage } from "@/components/public-info-page";
import { siteUrl } from "@/lib/public-home";
import { operatorName, privacyEmail } from "@/lib/public-operator";

export const ensureStatic = "shell";

export const metadata: Metadata = {
  title: "Contact Poimio",
  description: "Contact the operator about privacy or report an issue with Poimio.",
  alternates: { canonical: `${siteUrl}contact` },
};

export default function ContactPage() {
  return (
    <PublicInfoPage title="Contact Poimio">
      <section aria-labelledby="feedback">
        <h2 id="feedback">Project feedback and bug reports</h2>
        <p>
          {operatorName} operates Poimio as a personal course project. Use the{" "}
          <a href="https://github.com/jonime/poimio/issues">public GitHub issue tracker</a> to
          report bugs, broken links or problems with the feed. Include the page or item link and the
          steps that led to the problem so it can be reproduced. Keep account details and other
          personal information out of public reports.
        </p>
      </section>
      <section aria-labelledby="privacy-requests">
        <h2 id="privacy-requests">Privacy and account requests</h2>
        <p>
          For questions about your personal information or to request access, correction or account
          deletion, email <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a>. For a deletion
          request, use the email address associated with your Poimio account if possible. The{" "}
          <Link href="/privacy">privacy policy</Link> explains what Poimio stores, how feedback is
          used and what happens when an account is deleted.
        </p>
      </section>
    </PublicInfoPage>
  );
}
