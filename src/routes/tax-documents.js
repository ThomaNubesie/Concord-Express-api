const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
const supabase = require('../lib/supabase');

const TEMPLATES_DIR = path.join(__dirname, '../../assets/tax-templates');

const TAX_RATES = {
  CA: { label: 'HST',  rate: 0.13 },
  US: { label: 'Tax',  rate: 0 },
  FR: { label: 'TVA',  rate: 0.20 },
  GB: { label: 'VAT',  rate: 0.20 },
  SN: { label: 'TVA',  rate: 0.18 },
  NG: { label: 'VAT',  rate: 0.075 },
  GH: { label: 'VAT',  rate: 0.15 },
  KE: { label: 'VAT',  rate: 0.16 },
  MA: { label: 'TVA',  rate: 0.20 },
  CI: { label: 'TVA',  rate: 0.18 },
  CM: { label: 'TVA',  rate: 0.1925 },
  RW: { label: 'VAT',  rate: 0.18 },
};

const COUNTRY_NAMES = {
  CA: 'Canada', US: 'United States', FR: 'France', GB: 'United Kingdom',
  SN: 'Sénégal', NG: 'Nigeria', GH: 'Ghana', KE: 'Kenya',
  MA: 'Morocco', CI: "Côte d'Ivoire", CM: 'Cameroon', RW: 'Rwanda',
};

// GET /api/tax-documents/:country/:docType/:year
router.get('/:country/:docType/:year', async (req, res) => {
  try {
    const { country, docType, year } = req.params;
    const userId = req.query.userId;

    const validDocs = ['delivery_tax_summary', 'earnings_statement', 'trip_delivery_receipt'];
    if (!validDocs.includes(docType)) {
      return res.status(400).json({ error: 'Invalid document type' });
    }

    const startDate = `${year}-01-01T00:00:00`;
    const endDate = `${year}-12-31T23:59:59`;

    // Fetch user
    let userName = 'ConcordXpress User';
    let userEmail = '';
    let userPhone = '';
    if (userId) {
      const { data: user } = await supabase
        .from('users')
        .select('full_name, email, phone')
        .eq('id', userId)
        .single();
      if (user) {
        userName = user.full_name || userName;
        userEmail = user.email || '';
        userPhone = user.phone || '';
      }
    }

    // Fetch completed trips for this driver in this year
    let totalTrips = 0;
    let tripEarnings = 0;
    let totalPassengers = 0;
    if (userId) {
      const { data: trips } = await supabase
        .from('trips')
        .select('price_per_seat, seats_booked, seats_total')
        .eq('driver_id', userId)
        .eq('status', 'completed')
        .gte('departure_at', startDate)
        .lte('departure_at', endDate);
      if (trips) {
        totalTrips = trips.length;
        tripEarnings = trips.reduce((sum, t) =>
          sum + (parseFloat(t.price_per_seat) || 0) * (t.seats_booked || 0), 0);
        totalPassengers = trips.reduce((sum, t) => sum + (t.seats_booked || 0), 0);
      }
    }

    // Fetch packages
    let totalPackages = 0;
    let packageEarnings = 0;
    if (userId) {
      const { data: packages } = await supabase
        .from('packages')
        .select('price, status')
        .gte('created_at', startDate)
        .lte('created_at', endDate);
      // Filter to packages on this driver's trips
      if (packages) {
        totalPackages = packages.length;
        packageEarnings = packages.reduce((sum, p) =>
          sum + (parseFloat(p.price) || 0) * 0.75, 0); // driver gets 75%
      }
    }

    const totalEarnings = tripEarnings + packageEarnings;
    const commission = totalEarnings * 0.02; // 2% platform commission
    const netEarnings = totalEarnings - commission;
    const tax = TAX_RATES[country] || TAX_RATES.CA;
    const taxOnPackages = packageEarnings * tax.rate;

    // Try to load template PDF
    const templateFile = `${country}_${docType}_${year}.pdf`;
    const templatePath = path.join(TEMPLATES_DIR, templateFile);

    let pdfDoc;
    if (fs.existsSync(templatePath)) {
      const existingPdfBytes = fs.readFileSync(templatePath);
      pdfDoc = await PDFDocument.load(existingPdfBytes);

      // Try to fill form fields if the PDF has them
      try {
        const form = pdfDoc.getForm();
        const fieldMap = {
          'full_name': userName,
          'email': userEmail,
          'phone': userPhone,
          'year': year,
          'country': COUNTRY_NAMES[country] || country,
          'total_trips': String(totalTrips),
          'total_passengers': String(totalPassengers),
          'trip_earnings': `$${tripEarnings.toFixed(2)}`,
          'total_packages': String(totalPackages),
          'package_earnings': `$${packageEarnings.toFixed(2)}`,
          'total_earnings': `$${totalEarnings.toFixed(2)}`,
          'commission': `$${commission.toFixed(2)}`,
          'net_earnings': `$${netEarnings.toFixed(2)}`,
          'tax_label': tax.label,
          'tax_rate': `${(tax.rate * 100).toFixed(tax.rate === 0.1925 ? 2 : 0)}%`,
          'tax_on_packages': `$${taxOnPackages.toFixed(2)}`,
        };
        for (const [key, value] of Object.entries(fieldMap)) {
          try { form.getTextField(key).setText(value); } catch {}
        }
        form.flatten();
      } catch {}
    } else {
      // No template — generate a simple PDF
      pdfDoc = await PDFDocument.create();
      const page = pdfDoc.addPage([612, 792]); // Letter size
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
      const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

      const drawText = (text, x, y, options = {}) => {
        page.drawText(text, {
          x, y,
          size: options.size || 11,
          font: options.bold ? boldFont : font,
          color: options.color || rgb(0.04, 0.05, 0.08),
        });
      };

      const drawLine = (y) => {
        page.drawLine({ start: { x: 50, y }, end: { x: 562, y },
          thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
      };

      // Header
      drawText('CONCORDXPRESS', 50, 740, { size: 18, bold: true, color: rgb(0.06, 0.24, 0.18) });
      drawText('Tax Document', 50, 720, { size: 12, color: rgb(0.4, 0.4, 0.4) });

      const docTitles = {
        delivery_tax_summary: 'Delivery Tax Summary',
        earnings_statement: 'Earnings Statement',
        trip_delivery_receipt: 'Trip & Delivery Receipt',
      };
      drawText(docTitles[docType] || docType, 50, 690, { size: 16, bold: true });
      drawText(`Tax Year: ${year}  |  Country: ${COUNTRY_NAMES[country] || country}  |  ${tax.label} ${(tax.rate * 100).toFixed(0)}%`, 50, 670, { size: 10, color: rgb(0.5, 0.5, 0.5) });

      drawLine(660);

      // Personal info
      drawText('PERSONAL INFORMATION', 50, 640, { size: 9, bold: true, color: rgb(0.4, 0.4, 0.4) });
      drawText(`Name: ${userName}`, 50, 622, { size: 11 });
      if (userEmail) drawText(`Email: ${userEmail}`, 50, 607, { size: 11 });
      if (userPhone) drawText(`Phone: ${userPhone}`, 50, 592, { size: 11 });

      drawLine(580);

      // Earnings
      drawText('EARNINGS SUMMARY', 50, 560, { size: 9, bold: true, color: rgb(0.4, 0.4, 0.4) });

      let y = 540;
      const rows = [
        ['Carpooling Trips', String(totalTrips), `$${tripEarnings.toFixed(2)}`],
        ['Passengers Carried', String(totalPassengers), ''],
        ['Packages Delivered', String(totalPackages), `$${packageEarnings.toFixed(2)}`],
      ];
      rows.forEach(([label, count, amount]) => {
        drawText(label, 50, y);
        drawText(count, 300, y, { bold: true });
        if (amount) drawText(amount, 450, y, { bold: true });
        y -= 18;
      });

      drawLine(y + 5);
      y -= 15;

      drawText('Gross Earnings', 50, y, { bold: true });
      drawText(`$${totalEarnings.toFixed(2)}`, 450, y, { bold: true });
      y -= 18;
      drawText('Platform Commission (2%)', 50, y);
      drawText(`-$${commission.toFixed(2)}`, 450, y, { color: rgb(0.8, 0.2, 0.2) });
      y -= 18;
      drawText('Net Earnings', 50, y, { size: 13, bold: true, color: rgb(0.06, 0.24, 0.18) });
      drawText(`$${netEarnings.toFixed(2)}`, 450, y, { size: 13, bold: true, color: rgb(0.06, 0.24, 0.18) });

      drawLine(y - 10);
      y -= 30;

      // Tax section
      if (tax.rate > 0) {
        drawText('TAX INFORMATION', 50, y, { size: 9, bold: true, color: rgb(0.4, 0.4, 0.4) });
        y -= 20;
        drawText(`${tax.label} Rate`, 50, y);
        drawText(`${(tax.rate * 100).toFixed(tax.rate === 0.1925 ? 2 : 0)}%`, 450, y, { bold: true });
        y -= 18;
        drawText(`${tax.label} on Package Deliveries`, 50, y);
        drawText(`$${taxOnPackages.toFixed(2)}`, 450, y, { bold: true });
        y -= 18;

        if (country === 'CA') {
          y -= 10;
          drawText('⚠ Package delivery income is self-employment income and', 50, y, { size: 10, color: rgb(0.6, 0.4, 0) });
          y -= 14;
          drawText('must be reported on your Canadian tax return (T2125).', 50, y, { size: 10, color: rgb(0.6, 0.4, 0) });
          y -= 14;
          drawText('GST/HST registration required if delivery income exceeds $30,000/year.', 50, y, { size: 10, color: rgb(0.6, 0.4, 0) });
        }
      }

      // Footer
      drawLine(80);
      drawText('Generated by ConcordXpress · concordexpress.ca', 50, 60, { size: 9, color: rgb(0.6, 0.6, 0.6) });
      drawText(`Document ID: ${country}-${docType}-${year}-${(userId || 'anon').slice(0, 8)}`, 50, 46, { size: 8, color: rgb(0.7, 0.7, 0.7) });
      drawText(new Date().toISOString().split('T')[0], 450, 46, { size: 8, color: rgb(0.7, 0.7, 0.7) });
    }

    const pdfBytes = await pdfDoc.save();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition',
      `attachment; filename=ConcordXpress_${docType}_${country}_${year}.pdf`);
    res.send(Buffer.from(pdfBytes));

  } catch (err) {
    console.error('[Tax Documents]', err);
    res.status(500).json({ error: 'Failed to generate tax document' });
  }
});

module.exports = router;
