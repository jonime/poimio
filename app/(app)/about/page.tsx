import type { Metadata } from "next";
import Link from "next/link";
import { PublicInfoPage } from "@/components/public-info-page";
import { siteUrl } from "@/lib/public-home";
import { operatorName } from "@/lib/public-operator";

export const ensureStatic = "shell";

export const metadata: Metadata = {
  title: "About Poimio | Content discovery app",
  description: "Learn how Poimio discovers Finnish and English articles and videos.",
  alternates: { canonical: `${siteUrl}about` },
};

export default function AboutPage() {
  return (
    <PublicInfoPage title="About Poimio">
      <section aria-labelledby="discovery">
        <h2 id="discovery">Discover articles and videos</h2>
        <p>
          Poimio is a content discovery app for Finnish and English articles and videos. It brings
          together recent items from selected RSS, Atom and YouTube feeds. Anyone can browse the
          guest preview on the homepage and follow a pick to the publisher or creator for the
          original article or video.
        </p>
      </section>
      <section aria-labelledby="recommendations">
        <h2 id="recommendations">Make your feed personal</h2>
        <p>
          Sign in with Google to get a personal feed. Liking an item helps Poimio recommend similar
          material. You can mark an item as seen or tell Poimio you are less interested in it, and
          return to your liked items later.
        </p>
      </section>
      <section aria-labelledby="project">
        <h2 id="project">Who operates Poimio</h2>
        <p>
          Poimio is a personal course project built and operated by {operatorName}. The{" "}
          <a href="https://github.com/jonime/poimio">public repository</a> documents the project and
          how recommendations work. See the <Link href="/contact">contact page</Link> for project
          feedback and the <Link href="/privacy">privacy policy</Link> for how Poimio handles
          account information.
        </p>
      </section>
    </PublicInfoPage>
  );
}
