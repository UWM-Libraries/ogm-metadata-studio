import React, { useEffect, useRef } from 'react';
import { Resource } from '../aardvark/model';
import { displayThumbnailUrl } from '../services/thumbnailUrl';
import { ResourceThumbnail } from './shared/ResourceThumbnail';

interface GalleryViewProps {
    resources: Resource[];
    thumbnails: Record<string, string | null>;

    onSelect?: (id: string) => void;
    onLoadMore?: () => void;
    hasMore?: boolean;
}

export const GalleryView: React.FC<GalleryViewProps> = ({ resources, thumbnails, onSelect, onLoadMore, hasMore }) => {
    const observerTarget = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries[0].isIntersecting && hasMore) {
                    onLoadMore?.();
                }
            },
            { threshold: 0.1, rootMargin: '100px' }
        );

        const currentTarget = observerTarget.current;
        if (currentTarget) {
            observer.observe(currentTarget);
        }

        return () => {
            if (currentTarget) {
                observer.unobserve(currentTarget);
            }
        };
    }, [hasMore, onLoadMore]);

    if (resources.length === 0) {
        return (
            <div className="flex h-64 items-center justify-center text-[#5a5547] dark:text-[#ffffff]/70">
                No results found.
            </div>
        );
    }

    return (
        <div className="flex flex-col">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-5 p-1">
                {resources.map(r => {
                    const thumbnailUrl = displayThumbnailUrl(r, thumbnails);
                    return (
                    <div
                        key={r.id}
                        className="ogm-result-card group cursor-pointer flex flex-col p-0"
                        onClick={() => onSelect?.(r.id)}
                    >
                        {/* Thumbnail Aspect Ratio 1:1 or 4:3? Aardvark usually squares. */}
                        <div className="aspect-square bg-[#f5f5f5] dark:bg-[#111111] flex items-center justify-center overflow-hidden relative border-b-2 border-[#111111] dark:border-[#f6d94d] ml-3">
                            <ResourceThumbnail
                                resource={r}
                                src={thumbnailUrl}
                                fallbackClassName="text-4xl opacity-10 select-none"
                            />

                            {/* Overlay Gradient for Text Readability? No, text below. */}

                            {/* Hover Overlay Actions? */}
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors" />
                        </div>

                        <div className="p-3 pl-5 flex flex-col flex-1">
                            <h3 className="text-xs ogm-result-title line-clamp-2 mb-2 leading-snug" title={r.dct_title_s}>
                                {r.dct_title_s}
                            </h3>
                            <div className="mt-auto flex items-center justify-between text-[10px] font-bold text-[#5a5547] dark:text-[#ffffff]/70">
                                <span>{r.gbl_indexYear_im || "-"}</span>
                                <span className="ogm-tag uppercase px-1">
                                    {r.gbl_resourceClass_sm?.[0] || "Item"}
                                </span>
                            </div>
                        </div>
                    </div>
                );
                })}
            </div>
            {/* Sentinel for infinite scroll */}
            {hasMore && <div ref={observerTarget} className="h-10 w-full" />}
        </div>
    );
};
