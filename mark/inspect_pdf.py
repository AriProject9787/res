from pypdf import PdfReader
import sys

try:
    reader = PdfReader('data.pdf')
    print(f"Total pages: {len(reader.pages)}")
    text_page_1 = reader.pages[0].extract_text()
    print("--- Page 1 Start ---")
    print(text_page_1[:2000]) # Print first 2000 chars
    print("--- Page 1 End ---")
except Exception as e:
    print(f"Error reading PDF: {e}")
