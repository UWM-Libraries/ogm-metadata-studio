import React, { useEffect, useState } from "react";
import { Resource } from "../../aardvark/model";

interface ResourceThumbnailProps {
    resource: Resource;
    src: string | null;
    alt?: string;
    className?: string;
    fallbackClassName?: string;
    title?: string;
}

export const ResourceThumbnail: React.FC<ResourceThumbnailProps> = ({
    resource,
    src,
    alt = "",
    className = "w-full h-full object-contain",
    fallbackClassName = "text-3xl opacity-20 grayscale select-none",
    title,
}) => {
    const [failedSrc, setFailedSrc] = useState<string | null>(null);

    useEffect(() => {
        setFailedSrc(null);
    }, [src]);

    if (src && src !== failedSrc) {
        return (
            <img
                src={src}
                alt={alt}
                className={className}
                onError={() => setFailedSrc(src)}
                referrerPolicy="no-referrer"
                title={title}
            />
        );
    }

    return (
        <span className={fallbackClassName} title={title || `No thumbnail for ${resource.dct_title_s}`}>
            {resource.gbl_resourceClass_sm?.includes("Maps") ? "🗺️" : "📄"}
        </span>
    );
};
