import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { AuthProvider } from '../../auth/AuthContext';
import { ResourceHeader } from './ResourceHeader';
import { ResourceSidebar } from './ResourceSidebar';
import { useResourcePreviewAssets } from './useResourcePreviewAssets';
import { Distribution, Resource } from '../../aardvark/model';

const renderWithAuth = (ui: React.ReactElement) => render(<AuthProvider>{ui}</AuthProvider>);

vi.mock('maplibre-gl', () => ({
    default: {
        Map: function Map() {
            return {
                remove: vi.fn(),
                on: vi.fn((_e: string, fn: () => void) => setTimeout(fn, 0)),
                addSource: vi.fn(),
                addLayer: vi.fn(),
                fitBounds: vi.fn(),
                addControl: vi.fn(),
            };
        },
        AttributionControl: vi.fn(function AttributionControl() { }),
    },
}));

vi.mock('./CopyButton', () => ({
    CopyButton: ({ text }: { text: string }) => <button data-testid="copy-btn" onClick={() => { }}>Copy</button>
}));

vi.mock('./useResourcePreviewAssets', () => ({
    useResourcePreviewAssets: vi.fn(),
}));

vi.mock('../../auth/useAuth', () => ({
    useAuth: () => ({ isSignedIn: true }),
}));

const FIXTURE_RES: Resource = {
    id: 'test-1',
    dct_title_s: 'Test Resource',
    gbl_resourceClass_sm: ['Map'],
    gbl_resourceType_sm: ['Paper Map'],
    dct_spatial_sm: ['USA'],
    dcat_bbox: 'ENVELOPE(-100,-80,40,30)',
    dct_references_s: JSON.stringify({ "http://schema.org/downloadUrl": "http://dl.com" }),
    gbl_indexYear_im: 2020,
    dct_creator_sm: ['Creator A'],
    dct_publisher_sm: ['Publisher B']
} as Resource;

beforeEach(() => {
    vi.mocked(useResourcePreviewAssets).mockReturnValue({
        thumbnailUrl: null,
        staticMapUrl: null,
        isLoadingThumbnail: false,
        isLoadingStaticMap: false,
    });
});

describe('ResourceHeader', () => {
    const mockOnNavigate = vi.fn();
    const mockOnDelete = vi.fn();
    const pagination = {
        position: 1,
        total: 10,
        prevId: 'prev-1',
        nextId: 'next-1'
    };

    it('renders breadcrumbs and title', () => {
        renderWithAuth(
            <ResourceHeader
                resource={FIXTURE_RES}
                pagination={pagination}
                onNavigate={mockOnNavigate}
                onDelete={mockOnDelete}
            />
        );
        expect(screen.getByText('Test Resource')).toBeInTheDocument();
        expect(screen.getByText('Map')).toBeDefined();
        expect(screen.getByText('Paper Map')).toBeDefined();
        expect(screen.getByText('USA')).toBeDefined();
        expect(screen.getByText('Publisher B')).toBeDefined();
        expect(screen.getByText(/2020/)).toBeDefined();
    });

    it('handles navigation', () => {
        renderWithAuth(
            <ResourceHeader
                resource={FIXTURE_RES}
                pagination={pagination}
                onNavigate={mockOnNavigate}
                onDelete={mockOnDelete}
            />
        );
        fireEvent.click(screen.getByText('Next'));
        expect(mockOnNavigate).toHaveBeenCalledWith('next-1');

        fireEvent.click(screen.getByText('Prev'));
        expect(mockOnNavigate).toHaveBeenCalledWith('prev-1');
    });

    it('handles delete', () => {
        renderWithAuth(
            <ResourceHeader
                resource={FIXTURE_RES}
                pagination={pagination}
                onNavigate={mockOnNavigate}
                onDelete={mockOnDelete}
            />
        );
        fireEvent.click(screen.getByText('Delete'));
        expect(mockOnDelete).toHaveBeenCalledWith('test-1');
    });
});

describe('ResourceSidebar', () => {
    it('renders map with bounds', () => {
        render(<ResourceSidebar resource={FIXTURE_RES} />);
        expect(screen.queryByText('No map extent available')).not.toBeInTheDocument();
    });

    it('renders download link', () => {
        render(<ResourceSidebar resource={FIXTURE_RES} />);
        expect(screen.getByRole('link', { name: 'Download resource' })).toHaveAttribute('href', 'http://dl.com');
    });

    it('renders related distributions above downloads', () => {
        const res = {
            ...FIXTURE_RES,
            dct_references_s: JSON.stringify({
                "http://schema.org/downloadUrl": "http://dl.com",
                "http://schema.org/thumbnailUrl": "https://example.com/thumbnail.jpg",
            }),
        };
        render(<ResourceSidebar resource={res} />);

        const relatedHeading = screen.getByText('Related Distributions');
        const downloadsHeading = screen.getByText('Downloads');
        expect(relatedHeading).toBeInTheDocument();
        expect(screen.getByText('Thumbnail')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', 'https://example.com/thumbnail.jpg');
        expect(relatedHeading.compareDocumentPosition(downloadsHeading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('renders generated artifact downloads from distributions', () => {
        const artifactDistributions: Distribution[] = [
            {
                resource_id: 'test-1',
                relation_key: 'https://opengeometadata.org/reference/aardvark-json',
                url: 'https://example.com/aardvark.json',
            },
            {
                resource_id: 'test-1',
                relation_key: 'http://schema.org/thumbnailUrl',
                url: 'https://example.com/thumbnail.jpg',
            },
        ];
        render(<ResourceSidebar resource={{ ...FIXTURE_RES, dct_references_s: undefined }} distributions={artifactDistributions} />);

        expect(screen.getByText('Aardvark JSON')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Download Aardvark JSON' })).toHaveAttribute('href', 'https://example.com/aardvark.json');
        expect(screen.getByText('Thumbnail')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', 'https://example.com/thumbnail.jpg');
        expect(screen.queryByRole('link', { name: /Download Thumbnail/i })).not.toBeInTheDocument();
    });

    it('renders citation', () => {
        render(<ResourceSidebar resource={FIXTURE_RES} />);
        // Citation: Creator A. (2020). Test Resource. Publisher B. window.location.href.
        expect(screen.getByText(/Creator A/)).toBeInTheDocument();
        expect(screen.getByText(/Publisher B/)).toBeInTheDocument();
    });

    it('handles missing bbox gracefully', () => {
        const res = { ...FIXTURE_RES, dcat_bbox: undefined };
        render(<ResourceSidebar resource={res} />);
        expect(screen.getByText('No map extent available')).toBeInTheDocument();
    });

    it('renders a static map fallback when no parseable bounds are available', () => {
        vi.mocked(useResourcePreviewAssets).mockReturnValue({
            thumbnailUrl: null,
            staticMapUrl: 'blob:http://localhost/static-map',
            isLoadingThumbnail: false,
            isLoadingStaticMap: false,
        });
        const res = { ...FIXTURE_RES, dcat_bbox: undefined };

        render(<ResourceSidebar resource={res} />);

        expect(screen.getByRole('img', { name: 'Location map for Test Resource' })).toHaveAttribute('src', 'blob:http://localhost/static-map');
        expect(screen.queryByText('No map extent available')).not.toBeInTheDocument();
    });

    it('uses projected UTM geometry with a CRS hint for the location map', () => {
        const res = {
            ...FIXTURE_RES,
            dcat_bbox: 'ENVELOPE(238379.23443976537,770421.3750486401,4654130.999994,3874070.9999999385)',
            locn_geometry: 'POLYGON((238379.23443976537 4654130.999994, 770421.3750486401 4654130.999994, 770421.3750486401 3874070.9999999385, 238379.23443976537 3874070.9999999385, 238379.23443976537 4654130.999994))',
            dct_description_sm: ['Coordinate reference system information is supplied as NAD 1983 UTM Zone 11N.'],
        };

        render(<ResourceSidebar resource={res} />);

        expect(screen.queryByText('No map extent available')).not.toBeInTheDocument();
        expect(screen.queryByRole('img', { name: 'Location map for Test Resource' })).not.toBeInTheDocument();
    });
});
