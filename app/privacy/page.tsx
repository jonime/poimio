import type { Metadata } from "next";
import { PublicInfoPage } from "@/components/public-info-page";
import { siteUrl } from "@/lib/public-home";
import { operatorName, privacyEmail } from "@/lib/public-operator";

export const ensureStatic = "shell";

export const metadata: Metadata = {
  title: "Privacy Policy | Poimio",
  description: "How Poimio handles account information and recommendation feedback.",
  alternates: { canonical: `${siteUrl}privacy` },
};

export default function PrivacyPage() {
  return (
    <PublicInfoPage
      title="Privacy Policy"
      subtitle={
        <p className="text-sm text-muted-foreground">
          Last updated: <time dateTime="2026-11-07">7 November 2026</time>
        </p>
      }
    >
      <section aria-labelledby="operator">
        <h2 id="operator">Who operates Poimio</h2>
        <p>
          Poimio is a personal course project operated by {operatorName}, the data controller. It
          recommends links to Finnish and English articles and videos based on your feedback. For
          privacy questions or requests, email <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a>
          .
        </p>
      </section>

      <section aria-labelledby="information">
        <h2 id="information">Information we process</h2>
        <ul>
          <li>
            Account information supplied through Google sign-in, including your email address, name,
            profile image URL where supplied, and account identifiers. Supabase Auth stores
            authentication and session information. Poimio does not receive your Google password or
            request access to Gmail, Drive, or your contacts.
          </li>
          <li>
            Your feedback: items you like, mark as not interested, or mark as seen, together with
            timestamps and whether you used a button or swipe. This information is associated with
            your account.
          </li>
          <li>
            Technical information needed to deliver and secure the service, such as IP addresses,
            browser information, and request or authentication logs processed by our hosting
            providers.
          </li>
          <li>
            Information you send us when contacting us about the service or exercising your privacy
            rights.
          </li>
        </ul>
      </section>

      <section aria-labelledby="purpose">
        <h2 id="purpose">How and why we use information</h2>
        <p>
          We use account information to sign you in and keep your feedback separate from other
          users. We use feedback to personalise your feed, hide rated items, and show your liked
          items. Recommendations are automated, but do not make decisions with legal or similarly
          significant effects. Your feedback is not shared with other users.
        </p>
        <p>
          Our legal basis for account and recommendation processing is providing the service you
          request (performance of a contract). Security, troubleshooting, and handling enquiries
          rely on our legitimate interests in maintaining and protecting the service. We do not sell
          your personal information or use it for advertising.
        </p>
      </section>

      <section aria-labelledby="providers">
        <h2 id="providers">Service providers and external content</h2>
        <p>
          Google handles Google sign-in. Supabase provides authentication and database storage, and
          Vercel hosts the application. These providers process information needed to perform their
          respective services.
        </p>
        <p>
          Vercel Speed Insights measures how quickly pages load and respond. Vercel receives
          performance measurements along with the page URL, browser and device information, network
          speed, and country. See{" "}
          <a href="https://vercel.com/docs/speed-insights/privacy-policy">
            what Speed Insights collects
          </a>
          .
        </p>
        <p>
          OpenAI processes public feed titles and descriptions to create numerical representations
          used for recommendations. Poimio does not send your Google account information or personal
          feedback to OpenAI. Recommendation comparisons run in the database.
        </p>
        <p>
          Thumbnails may load directly from external publishers or image hosts, which receive your
          IP address and browser request information. Opening an article or video takes you to
          another website, whose own privacy policy applies.
        </p>
        <p>
          Providers may process information outside your country, including outside the European
          Economic Area. Their privacy documentation describes their processing locations and
          international-transfer safeguards:{" "}
          <a href="https://policies.google.com/privacy">Google</a>,{" "}
          <a href="https://supabase.com/privacy">Supabase</a>,{" "}
          <a href="https://vercel.com/legal/privacy-policy">Vercel</a>, and{" "}
          <a href="https://openai.com/policies/privacy-policy/">OpenAI</a>.
        </p>
      </section>

      <section aria-labelledby="cookies">
        <h2 id="cookies">Cookies</h2>
        <p>
          Poimio uses necessary authentication cookies to maintain your session. Google and websites
          you visit through external links may use their own cookies under their own policies.
        </p>
      </section>

      <section aria-labelledby="retention">
        <h2 id="retention">Retention and deletion</h2>
        <p>
          We keep your account and feedback until you request deletion. To request deletion, email{" "}
          {privacyEmail}, preferably from the address associated with your account. We may need to
          verify your identity before acting. Account deletion also removes the associated feedback
          from the active database. Provider logs and backup copies may remain for their applicable
          retention periods or where legally required; deletion is not a promise of immediate
          removal from all backups. Public feed content is not deleted with your account.
        </p>
      </section>

      <section aria-labelledby="rights">
        <h2 id="rights">Your rights</h2>
        <p>
          Where applicable under data-protection law, you may request access, correction, deletion,
          restriction, or a portable copy of your personal information, and object to processing
          based on legitimate interests. Contact{" "}
          <a href={`mailto:${privacyEmail}`}>{privacyEmail}</a> to exercise these rights. You may
          also lodge a complaint with your local data-protection authority. Removing Poimio from
          your Google account connections revokes Google access, but does not by itself delete
          information already stored in Poimio.
        </p>
      </section>

      <section aria-labelledby="changes">
        <h2 id="changes">Changes to this policy</h2>
        <p>
          We will update this page when our data handling changes and revise the date above.
          Material changes will be brought to users&apos; attention within the service.
        </p>
      </section>
    </PublicInfoPage>
  );
}
