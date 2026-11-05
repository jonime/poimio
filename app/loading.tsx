import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-20" aria-busy="true">
      <p role="status" className="sr-only">
        Loading...
      </p>
      <Skeleton className="h-8 w-40" />
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-48 w-full rounded-xl" />
      ))}
    </main>
  );
}
