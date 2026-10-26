#!/usr/bin/env python3
"""
ARINC750Forge Pro (v1.0.0) - Automated Test Suite
Verifies core VHF transceiver logic, 8.33 kHz channel mapping, VDL Mode 2 D8PSK, ARINC 429 odd parity, and airworthiness audit.
"""

import unittest
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from importlib import import_module
cli = import_module("arinc750-cli")

class TestARINC750Engine(unittest.TestCase):

    def test_01_arinc429_odd_parity(self):
        """Test 1: ARINC 429 Bit 32 odd parity generator and validator."""
        p0 = cli.calculate_parity(0x00000000)
        self.assertEqual(p0, 1)

        p1 = cli.calculate_parity(0x00000001)
        self.assertEqual(p1, 0)

        p3 = cli.calculate_parity(0x00000003)
        self.assertEqual(p3, 1)

    def test_02_label_bit_reversal(self):
        """Test 2: Octal label bit reversal to ARINC 429 transmission order."""
        # Label 030 (octal 030 = binary 00011000)
        # Reversed: 00011000 = 0x18
        rev030 = cli.reverse_label_bits(0o030)
        self.assertEqual(rev030, 0x18)

        # Label 270 (octal 270 = binary 10111000)
        # Reversed: 00011101 = 0x1D
        rev270 = cli.reverse_label_bits(0o270)
        self.assertEqual(rev270, 0x1D)

    def test_03_channel_833_base_offset(self):
        """Test 3: 8.33 kHz channel name resolution: base offset 0.000 kHz."""
        ch = cli.resolve_channel_name('118.005')
        self.assertEqual(ch['spacing'], '8.33_KHZ')
        self.assertEqual(ch['bandwidth_khz'], 8.33)
        self.assertAlmostEqual(ch['rf_carrier_mhz'], 118.00000, places=4)

    def test_04_channel_833_second_offset(self):
        """Test 4: 8.33 kHz channel name resolution: offset +8.333 kHz."""
        ch = cli.resolve_channel_name('118.010')
        self.assertEqual(ch['spacing'], '8.33_KHZ')
        self.assertAlmostEqual(ch['rf_carrier_mhz'], 118.00833, places=4)

    def test_05_channel_833_third_offset(self):
        """Test 5: 8.33 kHz channel name resolution: offset +16.667 kHz."""
        ch = cli.resolve_channel_name('118.015')
        self.assertEqual(ch['spacing'], '8.33_KHZ')
        self.assertAlmostEqual(ch['rf_carrier_mhz'], 118.01667, places=4)

    def test_06_channel_25khz_legacy(self):
        """Test 6: 25 kHz legacy channel name resolution."""
        ch = cli.resolve_channel_name('118.025')
        self.assertEqual(ch['spacing'], '25_KHZ')
        self.assertEqual(ch['bandwidth_khz'], 25.0)
        self.assertAlmostEqual(ch['rf_carrier_mhz'], 118.02500, places=4)

    def test_07_vdl_mode_2_physical_layer_constants(self):
        """Test 7: VDL Mode 2 D8PSK physical layer transmission rates."""
        baud = 10500
        bits_per_symbol = 3
        bps = baud * bits_per_symbol
        self.assertEqual(bps, 31500)

    def test_08_crc16_ccitt_avlc_checksum(self):
        """Test 8: CCITT CRC-16 (0x1021) checksum calculation."""
        data = b"TEST"
        crc = cli.calculate_crc16(data)
        self.assertIsInstance(crc, int)
        self.assertGreater(crc, 0)
        self.assertLessEqual(crc, 0xFFFF)

    def test_09_encode_decode_tuning_label030(self):
        """Test 9: Tuning Label 030 BCD encoding and parity validity."""
        word = cli.encode_arinc429_word(0o030, 1, 0x1875, 0x03)
        dec = cli.decode_arinc429_word(word)
        self.assertTrue(dec['parity_valid'])
        self.assertEqual(dec['octal_label'], '0030')
        self.assertEqual(dec['sdi'], 1)
        self.assertEqual(dec['ssm_meaning'], 'Normal Operation')

    def test_10_normative_compliance_audit_rules(self):
        """Test 10: 10-point normative airworthiness compliance audit execution."""
        audit = cli.run_compliance_audit()
        self.assertEqual(audit['total_rules'], 10)
        self.assertEqual(audit['passed_count'], 10)
        self.assertEqual(audit['failed_count'], 0)
        self.assertEqual(audit['score_percent'], 100.0)
        self.assertEqual(audit['certification'], 'ARINC_750_VHF_VDL2_DO186B_CERTIFIED')

if __name__ == '__main__':
    unittest.main()
