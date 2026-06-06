import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TimelineFacet } from './TimelineFacet';

// Mock Recharts
vi.mock('recharts', () => ({
    ResponsiveContainer: ({ children }: any) => <div>{children}</div>,
    BarChart: ({ children, onMouseDown, onMouseMove, onMouseUp }: any) => (
        <div data-testid="bar-chart">
            BarChart {children}
            <button
                data-testid="trigger-drag"
                onClick={() => {
                    onMouseDown({ activeLabel: 2000 });
                    onMouseMove({ activeLabel: 2002 });
                    onMouseUp();
                }}
            >
                Trigger drag
            </button>
        </div>
    ),
    Bar: ({ children }: any) => <div>Bar {children}</div>,
    Cell: () => null,
    XAxis: () => <div>XAxis</div>,
    Tooltip: () => <div>Tooltip</div>,
    ReferenceArea: () => <div>ReferenceArea</div>
}));

describe('TimelineFacet', () => {
    const mockData = [
        { value: '2000', count: 10 },
        { value: '2001', count: 5 },
        { value: '2002', count: 8 }
    ];

    it('renders nothing if no data', () => {
        const { container } = render(<TimelineFacet data={[]} onChange={vi.fn()} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders chart with data', () => {
        render(<TimelineFacet data={mockData} onChange={vi.fn()} />);
        expect(screen.getByText('Year Distribution')).toBeDefined();
        expect(screen.getByText('BarChart')).toBeDefined();
        expect(screen.getByTestId('timeline-selected-range')).toHaveTextContent('All Years');
        expect(screen.getByLabelText('Start year')).toHaveValue('2000');
        expect(screen.getByLabelText('End year')).toHaveValue('2002');
    });

    it('selects a single year from an accessible bar control', () => {
        const onChange = vi.fn();
        render(<TimelineFacet data={mockData} onChange={onChange} />);

        fireEvent.click(screen.getByRole('button', { name: 'Select 2001' }));

        expect(onChange).toHaveBeenCalledWith({ start: 2001, end: 2001 });
    });

    it('selects a dragged range from chart events', () => {
        const onChange = vi.fn();
        render(<TimelineFacet data={mockData} onChange={onChange} />);

        fireEvent.click(screen.getByTestId('trigger-drag'));

        expect(onChange).toHaveBeenCalledWith({ start: 2000, end: 2002 });
    });

    it('renders selected range text and clears it', () => {
        const onChange = vi.fn();
        render(<TimelineFacet data={mockData} range={{ start: 2000, end: 2001 }} onChange={onChange} />);

        expect(screen.getByTestId('timeline-selected-range')).toHaveTextContent('2000 - 2001');

        fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
        expect(onChange).toHaveBeenCalledWith(undefined);
    });

    it('allows start-only manual input', () => {
        const onChange = vi.fn();
        render(<TimelineFacet data={mockData} onChange={onChange} />);

        fireEvent.change(screen.getByLabelText('Start year'), { target: { value: '2001' } });
        fireEvent.change(screen.getByLabelText('End year'), { target: { value: '' } });
        fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

        expect(onChange).toHaveBeenCalledWith({ start: 2001, end: null });
    });

    it('allows end-only manual input', () => {
        const onChange = vi.fn();
        render(<TimelineFacet data={mockData} onChange={onChange} />);

        fireEvent.change(screen.getByLabelText('Start year'), { target: { value: '' } });
        fireEvent.change(screen.getByLabelText('End year'), { target: { value: '2001' } });
        fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

        expect(onChange).toHaveBeenCalledWith({ start: null, end: 2001 });
    });

    it('normalizes reversed manual input', () => {
        const onChange = vi.fn();
        render(<TimelineFacet data={mockData} onChange={onChange} />);

        fireEvent.change(screen.getByLabelText('Start year'), { target: { value: '2002' } });
        fireEvent.change(screen.getByLabelText('End year'), { target: { value: '2000' } });
        fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

        expect(onChange).toHaveBeenCalledWith({ start: 2000, end: 2002 });
    });

    it('validates manual input', () => {
        const onChange = vi.fn();
        render(<TimelineFacet data={mockData} onChange={onChange} />);

        fireEvent.change(screen.getByLabelText('Start year'), { target: { value: '999' } });
        fireEvent.change(screen.getByLabelText('End year'), { target: { value: '' } });
        fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

        expect(screen.getByText('Enter years as 4-digit numbers.')).toBeDefined();
        expect(onChange).not.toHaveBeenCalled();
    });

    it('buckets long timelines by decade', () => {
        const onChange = vi.fn();
        const manyYears = Array.from({ length: 60 }, (_, index) => ({ value: String(1900 + index), count: 1 }));
        render(<TimelineFacet data={manyYears} onChange={onChange} />);

        fireEvent.click(screen.getByRole('button', { name: 'Select 1930 to 1939' }));

        expect(onChange).toHaveBeenCalledWith({ start: 1930, end: 1939 });
    });
});
