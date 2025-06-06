import xml.etree.ElementTree as ET
from pathlib import Path

#file = "npl_planlagt.gpx"
file =  "NPL.gpx"


# Load the GPX file content
gpx_content = Path(file).read_text(encoding='utf-8')

# Parse the XML content
namespace = {'': 'http://www.topografix.com/GPX/1/1'}
tree = ET.ElementTree(ET.fromstring(gpx_content))
root = tree.getroot()

# Sort the <trk> elements by their <name> elements
tracks = root.findall('.//trk', namespace)
tracks.sort(key=lambda trk: trk.find('.//name', namespace).text)

# Remove existing tracks and re-add them in sorted order
for trk in root.findall('.//trk', namespace):
    root.remove(trk)

for trk in tracks:
    root.append(trk)

# Register the default namespace to avoid ns0 prefixes
ET.register_namespace('', 'http://www.topografix.com/GPX/1/1')

# Write the sorted XML to a string or file
sorted_gpx_content = ET.tostring(root, encoding='utf-8', xml_declaration=True).decode('utf-8')
Path("sorted_" + file).write_text(sorted_gpx_content, encoding='utf-8')