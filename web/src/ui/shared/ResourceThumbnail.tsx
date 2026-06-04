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
    const [retryToken, setRetryToken] = useState(0);

    useEffect(() => {
        setFailedSrc(null);
        setRetryToken(0);
    }, [src]);

    if (src && src !== failedSrc) {
        return (
            <img
                key={`${src}:${retryToken}`}
                src={src}
                alt={alt}
                className={className}
                loading="eager"
                decoding="async"
                onError={() => {
                    if (retryToken < 2) {
                        window.setTimeout(() => setRetryToken((current) => current + 1), 150 * (retryToken + 1));
                        return;
                    }
                    setFailedSrc(src);
                }}
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
