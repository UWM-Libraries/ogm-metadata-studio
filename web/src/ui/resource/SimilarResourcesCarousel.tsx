import React, { useEffect, useMemo, useState } from 'react';
import { Resource } from '../../aardvark/model';
import { Link } from '../Link';
import { displayThumbnailUrl } from '../../services/thumbnailUrl';
import { ResourceThumbnail } from '../shared/ResourceThumbnail';
import { useThumbnailQueue } from '../../hooks/useThumbnailQueue';

const ITEMS_PER_PAGE = 4;

export const SimilarResourcesCarousel: React.FC<{ items: Resource[] }> = ({ items }) => {
    const [currentPage, setCurrentPage] = useState(0);
    const { thumbnails, register } = useThumbnailQueue();
    const totalPages = Math.ceil(items.length / ITEMS_PER_PAGE);

    const handlePrev = () => {
        setCurrentPage(p => Math.max(0, p - 1));
    };

    const handleNext = () => {
        setCurrentPage(p => Math.min(totalPages - 1, p + 1));
    };

    const currentItems = useMemo(
        () => items.slice(currentPage * ITEMS_PER_PAGE, (currentPage + 1) * ITEMS_PER_PAGE),
        [currentPage, items],
    );

    useEffect(() => {
        for (const item of currentItems) register(item.id, item);
    }, [currentItems, register]);

    if (items.length === 0) return null;

    return (
        <section className="ogm-resource-similar ogm-page-card p-6">
            <h2 className="ogm-page-card-title mb-6 text-xl">Similar Items</h2>
            <div className="relative group">
                {/* Grid for items */}
                <div className="mb-6 grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
                    {currentItems.map((item) => {
                        const thumbnailUrl = displayThumbnailUrl(item, thumbnails);
                        return (
                        <Link
                            key={item.id}
                            href={`/resources/${item.id}`}
                            className="group/card focus:outline-none focus:ring-2 focus:ring-[#2f62b8]"
                        >
                            <div className="ogm-resource-similar-card h-full overflow-hidden">
                                {/* Thumbnail */}
                                <div className="ogm-media-frame relative flex h-40 items-center justify-center overflow-hidden text-slate-400">
                                    <ResourceThumbnail
                                        resource={item}
                                        src={thumbnailUrl}
                                        className="w-full h-full object-contain transition-transform duration-500 group-hover/card:scale-105"
                                        fallbackClassName="text-4xl opacity-30 grayscale select-none"
                                    />
                                </div>

                                {/* Content */}
                                <div className="flex flex-1 flex-col p-4">
                                    <h3 className="ogm-result-title mb-2 line-clamp-2 text-sm">
                                        {item.dct_title_s}
                                    </h3>
                                    <div className="ogm-page-copy mt-auto text-xs">
                                        {item.dct_publisher_sm?.[0] || 'Unknown Publisher'}
                                        <span className="mx-1">&middot;</span>
                                        {item.gbl_indexYear_im || 'n.d.'}
                                    </div>
                                </div>
                            </div>
                        </Link>
                    );
                    })}
                </div>

                {/* Controls */}
                {totalPages > 1 && (
                    <div className="flex items-center justify-center gap-4">
                        <button
                            onClick={handlePrev}
                            disabled={currentPage === 0}
                            className="ogm-page-button p-2"
                            aria-label="Previous page"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                                <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 01-.02 1.06L8.832 10l3.938 3.71a.75.75 0 11-1.04 1.08l-4.5-4.25a.75.75 0 010-1.08l4.5-4.25a.75.75 0 011.06.02z" clipRule="evenodd" />
                            </svg>
                        </button>

                        <div className="flex gap-2">
                            {Array.from({ length: totalPages }).map((_, i) => (
                                <button
                                    key={i}
                                    onClick={() => setCurrentPage(i)}
                                    className={`h-2 w-2 rounded-full border border-[#111111] transition-colors dark:border-[#f6d94d] ${i === currentPage
                                        ? 'bg-[#111111] dark:bg-[#f6d94d]'
                                        : 'bg-[#ffffff] dark:bg-[#111111]'
                                        }`}
                                    aria-label={`Go to page ${i + 1}`}
                                    aria-current={i === currentPage ? 'page' : undefined}
                                />
                            ))}
                        </div>

                        <button
                            onClick={handleNext}
                            disabled={currentPage === totalPages - 1}
                            className="ogm-page-button p-2"
                            aria-label="Next page"
                        >
                            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
                                <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" />
                            </svg>
                        </button>
                    </div>
                )}
            </div>
        </section>
    );
};
