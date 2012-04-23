import jingo
import waffle

from amo.utils import paginate

from mkt.developers.views import home as devhub_home
from mkt.webapps.models import Webapp


def home(request):
    """The home page."""
    if not waffle.switch_is_active('unleash-consumer'):
        return devhub_home
    featured = Webapp.featured('home')[:6]
    popular = paginate(request, Webapp.popular(), count=6)
    return jingo.render(request, 'home/home.html', {
        'featured': featured,
        'popular': popular
    })