import { useId } from "react";

/** The Jun Desk mark: four lobes with the #E0BBE4 → #957DAD gradient (from the earlier desk prototype). */
export function DeskIcon({ className }: { className?: string }) {
  const gradient = `desk-mark-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={gradient} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#E0BBE4" />
          <stop offset="100%" stopColor="#957DAD" />
        </linearGradient>
      </defs>
      <path
        d="M 13.628 20.868 C 13.128 20.763 12.609 20.707 12.078 20.707 C 7.893 20.707 4.5 24.138 4.5 28.37 C 4.5 32.602 7.893 36.033 12.078 36.033 C 16.263 36.033 19.656 32.602 19.656 28.37 C 19.656 27.894 19.613 27.429 19.531 26.977 L 20.503 26.977 C 20.399 27.483 20.345 28.007 20.345 28.544 C 20.345 32.776 23.737 36.207 27.922 36.207 C 32.107 36.207 35.5 32.776 35.5 28.544 C 35.5 24.312 32.107 20.881 27.922 20.881 C 27.46 20.881 26.999 20.923 26.545 21.008 L 26.545 20.407 C 26.999 20.491 27.46 20.533 27.922 20.533 C 32.107 20.533 35.5 17.102 35.5 12.87 C 35.5 8.638 32.107 5.207 27.922 5.207 C 23.737 5.207 20.344 8.638 20.344 12.87 C 20.344 13.219 20.368 13.569 20.414 13.915 L 19.586 13.915 C 19.632 13.574 19.656 13.225 19.656 12.87 C 19.656 8.638 16.263 5.207 12.078 5.207 C 7.893 5.207 4.5 8.638 4.5 12.87 C 4.5 17.102 7.893 20.533 12.078 20.533 C 12.609 20.533 13.128 20.478 13.628 20.372 Z"
        fill={`url(#${gradient})`}
      />
    </svg>
  );
}
